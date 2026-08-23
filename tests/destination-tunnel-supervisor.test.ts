import net from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { superviseDestinationTcpTunnel } from '../src/destination-tunnel-supervisor';
import {
  DESTINATION_TUNNEL_VERSION,
  type DestinationTunnelClientMessage,
} from '../src/destination-tunnel';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('destination tunnel supervisor', () => {
  let remoteServer: WebSocketServer;
  let sockets: WebSocket[];
  let startMessages: DestinationTunnelClientMessage[];
  let readyCounter: number;
  let rejectNext: string | undefined;

  beforeEach(async () => {
    sockets = [];
    startMessages = [];
    readyCounter = 0;
    rejectNext = undefined;
    remoteServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    remoteServer.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString('utf8')) as DestinationTunnelClientMessage;
        if (message.type !== 'start') return;
        startMessages.push(message);
        if (rejectNext) {
          socket.send(JSON.stringify({ type: 'error', code: rejectNext }));
          return;
        }
        readyCounter += 1;
        socket.send(
          JSON.stringify({
            type: 'ready',
            version: DESTINATION_TUNNEL_VERSION,
            tunnelId: `tunnel-${readyCounter}`,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => remoteServer.once('listening', resolve));
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
  });

  function remoteURL(): string {
    const address = remoteServer.address() as net.AddressInfo;
    return `ws://127.0.0.1:${address.port}/tunnel`;
  }

  test('reconnects with a new generation replaying the same selectors', async () => {
    const generations: string[] = [];
    const supervised = await superviseDestinationTcpTunnel(remoteURL(), 'token', {
      routes: [{ host: 'localhost', port: 8080 }],
      domains: ['*.corp.example'],
      logLevel: 'none',
      initialBackoffMs: 10,
      maxBackoffMs: 50,
      onGeneration: (tunnel) => generations.push(tunnel.tunnelId),
    });
    expect(supervised.tunnelId).toBe('tunnel-1');
    expect(supervised.getConnectionState()).toBe('connected');

    sockets[0]!.terminate();
    await waitFor(() => generations.length === 2);
    expect(supervised.tunnelId).toBe('tunnel-2');
    expect(supervised.getConnectionState()).toBe('connected');
    expect(startMessages).toHaveLength(2);
    expect(startMessages[1]).toEqual(startMessages[0]);

    supervised.close();
    await supervised.closed;
    expect(supervised.getConnectionState()).toBe('disconnected');
  });

  test('stops without retrying after a terminal server rejection', async () => {
    const supervised = await superviseDestinationTcpTunnel(remoteURL(), 'token', {
      routes: [{ host: 'localhost', port: 8080 }],
      logLevel: 'none',
      initialBackoffMs: 10,
    });
    rejectNext = 'already_active';
    sockets[0]!.terminate();
    await supervised.closed;
    expect(supervised.getConnectionState()).toBe('disconnected');
    // Exactly one retry attempt happened, and it was rejected terminally.
    expect(startMessages).toHaveLength(2);
  });

  test('consults shouldReconnect before every retry', async () => {
    let allowReconnect = true;
    const supervised = await superviseDestinationTcpTunnel(remoteURL(), 'token', {
      routes: [{ host: 'localhost', port: 8080 }],
      logLevel: 'none',
      initialBackoffMs: 10,
      shouldReconnect: () => allowReconnect,
    });
    allowReconnect = false;
    sockets[0]!.terminate();
    await supervised.closed;
    expect(startMessages).toHaveLength(1);
    expect(supervised.getConnectionState()).toBe('disconnected');
  });

  test('first-attempt failures reject instead of retrying', async () => {
    rejectNext = 'unavailable';
    await expect(
      superviseDestinationTcpTunnel(remoteURL(), 'token', {
        routes: [{ host: 'localhost', port: 8080 }],
        logLevel: 'none',
        handshakeTimeoutMs: 500,
      }),
    ).rejects.toThrow('destination tunnel failed: unavailable');
  });
});
