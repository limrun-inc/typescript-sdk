import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import IosForward from './forward';
import { resolveIosConnection } from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({ resolveIosConnection: jest.fn() }));

type Ready = { instanceId: string; localHost: string; localPort: number; remotePort: number };

function command(mapping: string, flags = { json: true, id: 'ios_test' }) {
  let ready!: (value: Ready) => void;
  const readiness = new Promise<Ready>((resolve) => {
    ready = resolve;
  });
  const instance = Object.assign(Object.create(IosForward.prototype), {
    parse: async () => ({ args: { mapping }, flags }),
    setParsedFlags: jest.fn(),
    withAuth: jest.fn(async (run: () => Promise<void>) => run()),
    resolveIosInstance: jest.fn(() => ({ id: 'ios_test', type: 'ios' })),
    outputJson: jest.fn(ready),
    output: jest.fn(),
    info: jest.fn(),
  });
  Object.defineProperty(instance, 'client', { value: {} });
  return { instance, readiness };
}

beforeEach(() => jest.clearAllMocks());

test.each([
  '',
  ':8100',
  '8100:',
  '1:2:3',
  '-1:8100',
  '1.5:8100',
  '1e3',
  'abc',
  '65536:80',
  '80:65536',
  '0',
  '80:0',
])('rejects invalid mapping %j before connecting', async (mapping) => {
  const { instance } = command(mapping);
  await expect(instance.run()).rejects.toThrow(/Mapping|Port/);
  expect(resolveIosConnection).not.toHaveBeenCalled();
});

test('reports unavailable instance credentials before opening a listener', async () => {
  jest.mocked(resolveIosConnection).mockRejectedValue(new Error('Instance is not ready'));
  await expect(command('8100').instance.run()).rejects.toThrow('Instance is not ready');
});

describe('forwarding through the simulator port-forward protocol', () => {
  let app: http.Server;
  let appWs: WebSocketServer;
  let relay: WebSocketServer;
  let backendSockets: Set<net.Socket>;
  let requests: http.IncomingMessage[];
  let run: Promise<void> | undefined;
  let rejectUpgrade: boolean;
  let remotePort: number;
  let originalSignals: number[];

  beforeEach(async () => {
    originalSignals = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
    backendSockets = new Set();
    requests = [];
    rejectUpgrade = false;
    app = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-request-path': req.url! });
      res.end(Buffer.concat(chunks));
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    remotePort = (app.address() as net.AddressInfo).port;
    appWs = new WebSocketServer({ server: app });
    appWs.on('connection', (ws) => ws.on('message', (data, binary) => ws.send(data, { binary })));
    relay = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, done) => done(!rejectUpgrade, 401, 'Unauthorized'),
    });
    // Match limulator's framing and lazy TCP connect on the first payload.
    relay.on('connection', (ws, req) => {
      requests.push(req);
      const connections = new Map<number, net.Socket>();
      ws.on('message', (data: Buffer) => {
        const id = data.readUInt32BE(0);
        const payload = data.subarray(4);
        if (!payload.length) {
          connections.get(id)?.destroy();
          return;
        }
        let socket = connections.get(id);
        if (!socket) {
          const port = Number(new URL(req.url!, 'http://localhost').searchParams.get('port'));
          socket = net.connect(port, '127.0.0.1');
          connections.set(id, socket);
          backendSockets.add(socket);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(id);
          socket.on('data', (chunk) => ws.send(Buffer.concat([header, chunk])));
          socket.on('error', () => {});
          socket.on('close', () => {
            connections.delete(id);
            if (ws.readyState === WebSocket.OPEN) ws.send(header);
          });
        }
        socket.write(payload);
      });
      ws.on('close', () => {
        for (const socket of connections.values()) socket.destroy();
      });
    });
    await once(relay, 'listening');
    jest.mocked(resolveIosConnection).mockResolvedValue({
      apiUrl: `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}/v1/ios/ios_test/`,
      token: 'test-instance-token',
    });
  });

  afterEach(async () => {
    if (run) {
      process.emit('SIGTERM');
      await run.catch(() => {});
      run = undefined;
    }
    for (const ws of relay.clients) ws.terminate();
    for (const socket of backendSockets) socket.destroy();
    for (const ws of appWs.clients) ws.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await new Promise<void>((resolve) => appWs.close(() => resolve()));
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    expect(['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal))).toEqual(originalSignals);
  });

  async function start(mapping = `0:${remotePort}`) {
    const { instance, readiness } = command(mapping);
    run = instance.run();
    const ready = await Promise.race([
      readiness,
      run!.then(() => {
        throw new Error('Exited before ready');
      }),
    ]);
    return { instance, ready };
  }

  test('forwards concurrent HTTP requests and WebSockets with authentication only on the relay', async () => {
    const { instance, ready } = await start();
    expect(ready).toEqual({
      instanceId: 'ios_test',
      localHost: '127.0.0.1',
      localPort: expect.any(Number),
      remotePort,
    });
    expect(ready.localPort).toBeGreaterThan(0);
    expect(instance.withAuth).toHaveBeenCalledWith(expect.any(Function), { createReplacement: false });
    expect(requests[0]!.url).toBe(`/v1/ios/ios_test/port-forward?port=${remotePort}&mode=multiplexed`);
    expect(requests[0]!.headers.authorization).toBe('Bearer test-instance-token');
    await Promise.all(
      [Buffer.from([0, 255, 13, 10]), Buffer.alloc(100_000, 42)].map(async (body, i) => {
        const response = await fetch(`http://127.0.0.1:${ready.localPort}/echo?request=${i}`, {
          method: 'POST',
          body,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('x-request-path')).toBe(`/echo?request=${i}`);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
      }),
    );
    const ws = new WebSocket(`ws://127.0.0.1:${ready.localPort}/socket`);
    try {
      await once(ws, 'open');
      const reply = once(ws, 'message');
      ws.send('hello from localhost');
      expect((await reply)[0].toString()).toBe('hello from localhost');
    } finally {
      ws.terminate();
    }
    expect(instance.output).not.toHaveBeenCalled();
    expect(JSON.stringify(instance.outputJson.mock.calls)).not.toContain('test-instance-token');
  });

  test.each(['SIGINT', 'SIGTERM'] as const)(
    '%s closes the listener and removes signal handlers',
    async (signal) => {
      const { ready } = await start();
      process.emit(signal);
      await run;
      const probe = net.connect(ready.localPort, '127.0.0.1');
      const [error] = await once(probe, 'error');
      expect(error.code).toBe('ECONNREFUSED');
      probe.destroy();
    },
  );

  test('a single port uses the same local and remote port and reports bind conflicts', async () => {
    const { instance } = command(String(remotePort));
    await expect(instance.run()).rejects.toThrow(/EADDRINUSE/);
    expect(instance.outputJson).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  test('an authentication failure rejects without announcing readiness', async () => {
    rejectUpgrade = true;
    const { instance } = command(`0:${remotePort}`);
    await expect(instance.run()).rejects.toThrow(/401/);
    expect(instance.outputJson).not.toHaveBeenCalled();
  });

  test('a terminal reconnect failure exits and closes the local port', async () => {
    const { ready } = await start();
    const failure = expect(run).rejects.toThrow('Port forward disconnected');
    rejectUpgrade = true;
    for (const ws of relay.clients) ws.terminate();
    await failure;
    const probe = net.connect(ready.localPort, '127.0.0.1');
    const [error] = await once(probe, 'error');
    expect(error.code).toBe('ECONNREFUSED');
    probe.destroy();
  });
});
