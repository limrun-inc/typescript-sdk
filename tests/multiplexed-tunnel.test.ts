import net from 'net';
import contract from './multiplexed-tunnel-v2.fixture.json';
import { once } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { startTcpTunnel, type Tunnel } from '../src/tunnel';
import {
  MUX_VERSION_HEADER,
  MUX_WINDOW,
  MUX_MAX_WINDOW,
  MUX_MAX_CONNECTIONS,
  MUX_CHUNK,
  muxFrame,
  MuxOp,
} from '../src/internal/multiplexed-tunnel';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await wait(5);
  }
}

describe('negotiated multiplexed transport', () => {
  let server: WebSocketServer;
  let tunnel: Tunnel | undefined;
  let sockets: net.Socket[];
  let version: string | undefined;
  let upgrades: number;
  let peer: WebSocket;
  let frames: Buffer[];

  beforeEach(async () => {
    sockets = [];
    version = '2';
    upgrades = 0;
    frames = [];
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('headers', (headers, req) => {
      expect(req.headers[MUX_VERSION_HEADER]).toBe('2');
      if (version) headers.push(`${MUX_VERSION_HEADER}: ${version}`);
    });
    server.on('connection', (ws) => {
      peer = ws;
      upgrades++;
      ws.on('message', (data: Buffer) => frames.push(data));
    });
    await once(server, 'listening');
  });
  afterEach(async () => {
    tunnel?.close();
    tunnel = undefined;
    for (const socket of sockets) socket.destroy();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  function start() {
    return startTcpTunnel(
      `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
      'test',
      '127.0.0.1',
      0,
      {
        mode: 'multiplexed',
        logLevel: 'none',
        reconnectDelay: 10,
        maxReconnectDelay: 10,
      },
    );
  }
  async function connect() {
    const socket = net.connect({ port: tunnel!.address.port, host: '127.0.0.1', allowHalfOpen: true });
    socket.on('error', () => {});
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  }

  test('OPEN allows the server to speak before the client sends bytes', async () => {
    tunnel = await start();
    const client = await connect();
    await until(() => frames.length === 1);
    expect(frames[0]).toEqual(muxFrame(MuxOp.open, 1));
    const received = once(client, 'data');
    peer.send(muxFrame(MuxOp.data, 1, Buffer.from('banner')));
    expect((await received)[0].toString()).toBe('banner');
  });

  test('exhausted credit pauses only that stream and a window update resumes it', async () => {
    tunnel = await start();
    const stalled = await connect();
    stalled.write(Buffer.alloc(2 * MUX_WINDOW));
    const sent = () =>
      frames
        .filter((f) => f[4] === MuxOp.data && f.readUInt32BE(0) === 1)
        .reduce((n, f) => n + f.length - 5, 0);
    await until(() => sent() === MUX_WINDOW);
    const other = await connect();
    other.write('ping');
    await until(() => frames.some((f) => f.readUInt32BE(0) === 2 && f[4] === MuxOp.data));
    expect(sent()).toBe(MUX_WINDOW);
    const increment = Buffer.alloc(4);
    increment.writeUInt32BE(MUX_CHUNK);
    peer.send(muxFrame(MuxOp.window, 1, increment));
    await until(() => sent() === MUX_WINDOW + MUX_CHUNK);
  });

  test.each(['text', 'oversize', 'credit', 'open'])(
    'malformed %s fails the session without falling back',
    async (kind) => {
      tunnel = await start();
      const client = await connect();
      await until(() => frames.length === 1);
      const closed = once(client, 'end');
      client.resume();
      if (kind === 'text') peer.send('invalid');
      else if (kind === 'oversize') peer.send(muxFrame(MuxOp.data, 1, Buffer.alloc(MUX_CHUNK + 1)));
      else if (kind === 'open') peer.send(muxFrame(MuxOp.open, 1));
      else {
        const amount = Buffer.alloc(4);
        amount.writeUInt32BE(MUX_MAX_WINDOW);
        peer.send(muxFrame(MuxOp.window, 1, amount));
      }
      await closed;
      expect(tunnel!.getConnectionState()).toBe('disconnected');
    },
  );

  test('an unsupported selected version is rejected', async () => {
    version = '3';
    await expect(start()).rejects.toThrow('unsupported multiplexed tunnel version');
  });

  test('a write failure reconnects instead of closing the listener', async () => {
    tunnel = await start();
    const client = await connect();
    await until(() => frames.length === 1);
    const send = jest.spyOn(WebSocket.prototype, 'send');
    send.mockImplementationOnce((_data: any, _options: any, callback: any) => {
      send.mockRestore();
      callback(new Error('connection reset during write'));
    });
    try {
      client.write('trigger write failure');
      await until(() => upgrades === 2 && tunnel!.getConnectionState() === 'connected');
      frames = [];
      await connect();
      await until(() => frames.length === 1);
      expect(frames[0]).toEqual(muxFrame(MuxOp.open, 1));
    } finally {
      send.mockRestore();
    }
  });

  test('reconnect renegotiates and destroys streams from the old session', async () => {
    tunnel = await start();
    const old = await connect();
    await until(() => frames.length === 1);
    const closed = once(old, 'end');
    old.resume();
    version = undefined;
    peer.terminate();
    await closed;
    await until(() => upgrades === 2 && tunnel!.getConnectionState() === 'connected');
    frames = [];
    const legacy = await connect();
    legacy.write('ping');
    await until(() => frames.length === 1);
    expect(frames[0]!.subarray(4).toString()).toBe('ping');
    const response = once(legacy, 'data');
    peer.send(frames[0]!);
    expect((await response)[0].toString()).toBe('ping');
  });
});

test('multiplexed wire contract matches Go and Swift', () => {
  expect([MUX_WINDOW, MUX_MAX_WINDOW, MUX_CHUNK, MUX_MAX_CONNECTIONS]).toEqual([
    contract.initialWindow,
    contract.maxWindow,
    contract.chunk,
    contract.maxConnections,
  ]);
  for (const sample of contract.frames) {
    expect(muxFrame(sample.op, sample.id, Buffer.from(sample.payload))).toEqual(Buffer.from(sample.bytes));
  }
});
