import net from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { deriveReverseTunnelUrl } from '../src/ios-client';
import {
  startReverseTcpTunnel,
  decodeConnectionHeader,
  encodeConnectionHeader,
  type ReverseTunnel,
} from '../src/tunnel';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('reverse tunnel helpers', () => {
  test('deriveReverseTunnelUrl preserves the iOS api path', () => {
    expect(deriveReverseTunnelUrl('https://node.example/v1/ios_123/api', 8081)).toBe(
      'wss://node.example/v1/ios_123/api/reverse-tunnel?remotePort=8081',
    );
  });

  test('deriveReverseTunnelUrl clears existing query and hash', () => {
    expect(deriveReverseTunnelUrl('http://node.example/v1/ios_123/api?token=old#frag', 8099)).toBe(
      'ws://node.example/v1/ios_123/api/reverse-tunnel?remotePort=8099',
    );
  });

  test('connection header round trips uint32 values', () => {
    for (const connId of [1, 255, 256, 65535, 0xffffffff]) {
      expect(decodeConnectionHeader(encodeConnectionHeader(connId))).toBe(connId);
    }
  });
});

// Mock of limulator's reverse-tunnel side: sends the ready control message on
// connect and counts the bytes of every [4-byte connID][payload] frame the
// client sends. Empty payloads are close signals.
function mockRemote(socket: WebSocket): {
  bytesByConn: Map<number, number>;
  closedConns: number[];
} {
  const bytesByConn = new Map<number, number>();
  const closedConns: number[] = [];
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return;
    const connId = decodeConnectionHeader(data.subarray(0, 4));
    const payloadLength = data.length - 4;
    if (payloadLength === 0) {
      closedConns.push(connId);
      return;
    }
    bytesByConn.set(connId, (bytesByConn.get(connId) ?? 0) + payloadLength);
  });
  socket.send(JSON.stringify({ type: 'ready', remoteHost: '10.0.0.1', remotePort: 57090 }));
  return { bytesByConn, closedConns };
}

describe('reverse tunnel data path', () => {
  let server: WebSocketServer;
  let remoteWs: WebSocket | undefined;
  let remoteState: ReturnType<typeof mockRemote> | undefined;
  let localServer: net.Server | undefined;
  let localPort: number;
  let tunnel: ReverseTunnel | undefined;

  beforeEach(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (socket) => {
      remoteWs = socket;
      remoteState = mockRemote(socket);
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });

  afterEach(async () => {
    tunnel?.close();
    tunnel = undefined;
    remoteWs = undefined;
    remoteState = undefined;
    if (localServer) {
      await new Promise<void>((resolve) => localServer!.close(() => resolve()));
      localServer = undefined;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function serverUrl(): string {
    const addr = server.address() as net.AddressInfo;
    return `ws://127.0.0.1:${addr.port}/reverse-tunnel?remotePort=57090`;
  }

  async function startLocalServer(onConnection: (socket: net.Socket) => void): Promise<void> {
    const server = net.createServer(onConnection);
    localServer = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    localPort = (server.address() as net.AddressInfo).port;
  }

  function frame(connId: number, payload: Buffer | string): Buffer {
    return Buffer.concat([encodeConnectionHeader(connId), Buffer.from(payload)]);
  }

  function receivedBytes(connId: number): number {
    return remoteState?.bytesByConn.get(connId) ?? 0;
  }

  test('relays a response and signals close only after the local source closes', async () => {
    const reply = Buffer.alloc(64 * 1024, 0x42);
    await startLocalServer((socket) => {
      socket.once('data', () => {
        // HTTP/1.0-style source: write the full response, then close.
        socket.end(reply);
      });
    });

    tunnel = await startReverseTcpTunnel(serverUrl(), 'test-token', {
      localPort,
      logLevel: 'none',
    });
    expect(tunnel.remoteAddress).toEqual({ address: '10.0.0.1', port: 57090 });

    remoteWs!.send(frame(1, 'GET /bundle'));
    await waitFor(() => (remoteState?.closedConns ?? []).includes(1));

    // Every response byte must have arrived before the close signal.
    expect(receivedBytes(1)).toBe(reply.length);
  });

  test('pauses local reads when the WebSocket buffer fills and still delivers everything', async () => {
    const total = 8 * 1024 * 1024;
    let sourceFlushed = false;
    await startLocalServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.alloc(total, 0x37), () => {
          sourceFlushed = true;
        });
      });
    });

    tunnel = await startReverseTcpTunnel(serverUrl(), 'test-token', {
      localPort,
      logLevel: 'none',
      maxBufferedBytes: 256 * 1024,
    });

    // Stall the remote's raw TCP socket so the client's bufferedAmount grows.
    const rawRemoteSocket = (remoteWs as any)._socket as net.Socket;
    rawRemoteSocket.pause();

    remoteWs!.send(frame(1, 'GET /bundle'));

    // With backpressure the client stops reading, so the source cannot flush
    // 8MB into it: only the buffer cap plus kernel buffers fit. Without the
    // fix the whole payload is consumed immediately and the flush completes.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sourceFlushed).toBe(false);

    rawRemoteSocket.resume();
    await waitFor(() => receivedBytes(1) === total, 15000);
    await waitFor(() => sourceFlushed);
  }, 20000);
});
