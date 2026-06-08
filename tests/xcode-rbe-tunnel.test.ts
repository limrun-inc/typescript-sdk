import net from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { deriveRbeTunnelUrl } from '../src/resources/xcode-instances-helpers';
import {
  startTcpTunnel,
  decodeConnectionHeader,
  encodeConnectionHeader,
  type Tunnel,
  type TunnelConnectionState,
} from '../src/tunnel';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('rbe tunnel url derivation', () => {
  // The tunnel layer appends ?mode=multiplexed itself, so deriveRbeTunnelUrl
  // must NOT add it (it would be redundant / double).
  test('deriveRbeTunnelUrl converts https apiUrl to wss without a mode query', () => {
    expect(deriveRbeTunnelUrl('https://node.example/v1/sandbox_123/xcode')).toBe(
      'wss://node.example/v1/sandbox_123/xcode/rbe/tunnel',
    );
  });

  test('deriveRbeTunnelUrl clears existing query and hash and trims trailing slash', () => {
    expect(deriveRbeTunnelUrl('http://node.example/v1/sandbox_123/xcode/?token=old#frag')).toBe(
      'ws://node.example/v1/sandbox_123/xcode/rbe/tunnel',
    );
  });

  test('deriveRbeTunnelUrl rejects non-http protocols', () => {
    expect(() => deriveRbeTunnelUrl('ftp://node.example/v1/x/xcode')).toThrow(/Unsupported apiUrl protocol/);
  });
});

// mockBackend implements the limbuild side of the multiplexed framing: binary
// frames of [4-byte big-endian connID][payload]; lazy dial of an in-test echo
// behavior on the first frame for a new connID; empty payload closes the conn.
// Instead of dialing a real loopback target it echoes payloads back uppercased,
// which lets assertions distinguish per-connection round trips.
function mockBackend(socket: WebSocket): { closedConns: number[] } {
  const known = new Set<number>();
  const closedConns: number[] = [];
  socket.on('message', (data: Buffer) => {
    const connId = decodeConnectionHeader(data.subarray(0, 4));
    const payload = data.subarray(4);
    if (payload.length === 0) {
      closedConns.push(connId);
      known.delete(connId);
      return;
    }
    known.add(connId);
    const reply = Buffer.from(payload.toString('utf8').toUpperCase(), 'utf8');
    socket.send(Buffer.concat([encodeConnectionHeader(connId), reply]));
  });
  return { closedConns };
}

describe('multiplexed rbe tunnel framing', () => {
  let server: WebSocketServer;
  let tunnel: Tunnel | undefined;
  let backendState: { closedConns: number[] } | undefined;
  let authHeader: string | undefined;

  beforeEach(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (socket, req) => {
      authHeader = req.headers.authorization;
      backendState = mockBackend(socket);
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });

  afterEach(async () => {
    tunnel?.close();
    tunnel = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function serverUrl(): string {
    const addr = server.address() as net.AddressInfo;
    return `ws://127.0.0.1:${addr.port}/rbe/tunnel?mode=multiplexed`;
  }

  function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket));
      socket.once('error', reject);
    });
  }

  function readOnce(socket: net.Socket): Promise<string> {
    return new Promise((resolve) => {
      socket.once('data', (data) => resolve(data.toString('utf8')));
    });
  }

  test('two concurrent connections round trip independently and close independently', async () => {
    tunnel = await startTcpTunnel(serverUrl(), 'test-token', '127.0.0.1', 0, {
      mode: 'multiplexed',
      logLevel: 'none',
    });
    const port = tunnel.address.port;

    const a = await connect(port);
    const b = await connect(port);

    a.write('hello-a');
    b.write('hello-b');
    const [replyA, replyB] = await Promise.all([readOnce(a), readOnce(b)]);
    expect(replyA).toBe('HELLO-A');
    expect(replyB).toBe('HELLO-B');

    // Bearer auth rode the upgrade request.
    expect(authHeader).toBe('Bearer test-token');

    // Closing one local socket emits a close frame for exactly that conn and
    // leaves the other usable.
    a.destroy();
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (backendState && backendState.closedConns.length > 0) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    expect(backendState!.closedConns).toHaveLength(1);

    b.write('still-alive');
    expect(await readOnce(b)).toBe('STILL-ALIVE');
    b.destroy();
  });

  test('connection ids are distinct per local connection', async () => {
    const seenIds = new Set<number>();
    server.removeAllListeners('connection');
    server.on('connection', (socket: WebSocket) => {
      socket.on('message', (data: Buffer) => {
        const connId = decodeConnectionHeader(data.subarray(0, 4));
        const payload = data.subarray(4);
        if (payload.length === 0) return;
        seenIds.add(connId);
        socket.send(Buffer.concat([encodeConnectionHeader(connId), payload]));
      });
    });

    tunnel = await startTcpTunnel(serverUrl(), 'test-token', '127.0.0.1', 0, {
      mode: 'multiplexed',
      logLevel: 'none',
    });
    const port = tunnel.address.port;

    const sockets = await Promise.all([connect(port), connect(port), connect(port)]);
    await Promise.all(
      sockets.map(async (socket, i) => {
        socket.write(`ping-${i}`);
        await readOnce(socket);
      }),
    );
    expect(seenIds.size).toBe(3);
    for (const socket of sockets) socket.destroy();
  });
});

describe('multiplexed rbe tunnel reconnect', () => {
  let server: WebSocketServer;
  let serverSockets: WebSocket[];
  let tunnel: Tunnel | undefined;

  beforeEach(async () => {
    serverSockets = [];
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (socket) => {
      serverSockets.push(socket);
      mockBackend(socket);
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });

  afterEach(async () => {
    tunnel?.close();
    tunnel = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function serverUrl(): string {
    const addr = server.address() as net.AddressInfo;
    return `ws://127.0.0.1:${addr.port}/rbe/tunnel?mode=multiplexed`;
  }
  function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket));
      socket.once('error', reject);
    });
  }
  function readOnce(socket: net.Socket): Promise<string> {
    return new Promise((resolve) => socket.once('data', (data) => resolve(data.toString('utf8'))));
  }

  test('reconnects after a transient WS drop and stays usable', async () => {
    const states: TunnelConnectionState[] = [];
    tunnel = await startTcpTunnel(serverUrl(), 'test-token', '127.0.0.1', 0, {
      mode: 'multiplexed',
      logLevel: 'none',
      reconnectDelay: 10,
      maxReconnectDelay: 30,
      maxReconnectAttempts: 5,
    });
    tunnel.onConnectionStateChange((s) => states.push(s));
    const port = tunnel.address.port;

    const a = await connect(port);
    a.write('hello');
    expect(await readOnce(a)).toBe('HELLO');
    expect(serverSockets).toHaveLength(1);

    // Simulate a transient network drop on the established WS.
    serverSockets[0]!.terminate();

    // The client keeps the listener up and reconnects (a 2nd server-side
    // connection is accepted), passing through 'reconnecting' back to 'connected'.
    await waitFor(() => serverSockets.length >= 2);
    await waitFor(() => tunnel!.getConnectionState() === 'connected');
    expect(states).toContain('reconnecting');

    // A new connection works after the reconnect.
    const b = await connect(port);
    b.write('world');
    expect(await readOnce(b)).toBe('WORLD');
    a.destroy();
    b.destroy();
  });

  test('gives up with a terminal disconnect after maxReconnectAttempts', async () => {
    const states: TunnelConnectionState[] = [];
    tunnel = await startTcpTunnel(serverUrl(), 'test-token', '127.0.0.1', 0, {
      mode: 'multiplexed',
      logLevel: 'none',
      reconnectDelay: 10,
      maxReconnectDelay: 20,
      maxReconnectAttempts: 3,
    });
    tunnel.onConnectionStateChange((s) => states.push(s));

    const a = await connect(tunnel.address.port);
    a.write('x');
    await readOnce(a);

    // Drop the connection AND take the whole server down so every reconnect
    // attempt fails; after maxReconnectAttempts the tunnel goes terminal.
    serverSockets[0]!.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await waitFor(() => tunnel!.getConnectionState() === 'disconnected', 5000);
    expect(states).toContain('reconnecting');
    expect(tunnel!.getConnectionState()).toBe('disconnected');
    a.destroy();
  });
});
