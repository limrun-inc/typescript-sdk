import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { Limrun } from '@limrun/api';
import '@limrun/api/resources/macos-instances-helpers';
import MacosForward from './forward';

type Ready = { instanceId: string; localHost: string; localPort: number; remotePort: number };

function command(mapping: string, resolve: () => Promise<unknown>) {
  let ready!: (value: Ready) => void;
  const readiness = new Promise<Ready>((r) => {
    ready = r;
  });
  const instance = Object.assign(Object.create(MacosForward.prototype), {
    parse: async () => ({ args: { mapping }, flags: { json: true, id: 'macos_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: jest.fn(async (run: () => Promise<void>) => run()),
    resolveMacosClient: jest.fn(resolve),
    outputJson: jest.fn(ready),
    output: jest.fn(),
    info: jest.fn(),
  });
  return { instance, readiness };
}

test.each(['', ':3000', '1:2:3', 'abc', '80:0', '65536:80'])(
  'rejects invalid mapping %j before reaching the instance',
  async (mapping) => {
    const resolve = jest.fn();
    await expect(command(mapping, resolve).instance.run()).rejects.toThrow(/Mapping|Port/);
    expect(resolve).not.toHaveBeenCalled();
  },
);

test('reports an instance that is not ready before opening a listener', async () => {
  const { instance } = command('3000', async () => {
    throw new Error('macOS instance macos_test is not ready yet.');
  });
  await expect(instance.run()).rejects.toThrow('not ready yet');
});

describe('forwarding through the guest API port forward', () => {
  let app: http.Server;
  let relay: WebSocketServer;
  let requests: http.IncomingMessage[];
  let sockets: Set<net.Socket>;
  let guestPaths: string[];

  beforeEach(async () => {
    requests = [];
    sockets = new Set();
    guestPaths = [];
    app = http.createServer((req, res) => {
      guestPaths.push(req.url ?? '');
      res.end('hello from the guest');
    });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    // Stands in for limacvm and the agent: the same framing, connecting to the guest loopback.
    relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
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
          sockets.add(socket);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(id);
          socket.on('data', (chunk) => ws.send(Buffer.concat([header, chunk])));
          socket.on('error', () => {});
          socket.on('close', () => {
            if (ws.readyState === WebSocket.OPEN) ws.send(header);
          });
        }
        socket.write(payload);
      });
    });
    await once(relay, 'listening');
  });

  afterEach(async () => {
    for (const ws of relay.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });

  test('carries a local connection to the guest port with the instance token', async () => {
    const remotePort = (app.address() as net.AddressInfo).port;
    const apiUrl = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}/v1/macos_test`;
    const client = await new Limrun({ apiKey: 'test' }).macosInstances.createClient({
      apiUrl,
      token: 'instance-token',
      logLevel: 'none',
    });
    const { instance, readiness } = command(`0:${remotePort}`, async () => ({ id: 'macos_test', client }));
    const run: Promise<void> = instance.run();
    try {
      const ready = await readiness;
      expect(ready).toMatchObject({ instanceId: 'macos_test', localHost: '127.0.0.1', remotePort });
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${ready.localPort}/hello`, (res) => {
            let text = '';
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve(text));
          })
          .on('error', reject);
      });
      expect(body).toBe('hello from the guest');
      expect(guestPaths).toEqual(['/hello']);
      const forwarded = new URL(requests[0]!.url!, 'http://relay');
      expect(forwarded.pathname).toBe('/v1/macos_test/port-forward');
      expect(forwarded.searchParams.get('port')).toBe(String(remotePort));
      expect(requests[0]!.headers.authorization).toBe('Bearer instance-token');
    } finally {
      process.emit('SIGTERM');
      await run;
    }
  });
});
