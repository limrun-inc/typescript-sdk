import net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WebSocket } from 'ws';
import { startTcpTunnel, type Tunnel } from '../src/tunnel';
import {
  MUX_VERSION_HEADER,
  MUX_WINDOW,
  MUX_CHUNK,
  MuxOp,
  muxFrame,
} from '../src/internal/multiplexed-tunnel';

const binary = process.env['MUX_TUNNEL_TEST_SERVER'];
const swift = process.env['MUX_TUNNEL_TEST_SERVER_KIND'] === 'swift';
const integration = binary ? describe : describe.skip;

integration('SDK against the production multiplexed relay', () => {
  let process: ChildProcess;
  let base: string;
  let server: net.Server;
  let sockets: Set<net.Socket>;
  let tunnels: Tunnel[];
  let clients: WebSocket[];

  beforeAll(async () => {
    process = spawn(binary!, swift ? [] : ['-test.run=^TestRBETunnelBenchmarkServer$', '-test.timeout=5m'], {
      env: { ...global.process.env, LIM_MUX_BENCH: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    base = await new Promise<string>((resolve, reject) => {
      let text = '';
      process.stdout!.on('data', (chunk) => {
        text += chunk;
        const match = text.match(/MUX_BENCH_URL=(\S+)/);
        if (match) resolve(match[1]!);
      });
      process.once('error', reject);
      process.once('exit', (code) => reject(new Error(`relay exited before ready: ${code}`)));
    });
  }, 30000);

  afterAll(async () => {
    const stopped = once(process, 'exit');
    // Vapor installs signal handlers; this fixture has no persistent state to drain.
    process.kill('SIGKILL');
    await stopped;
  });

  beforeEach(() => {
    sockets = new Set();
    tunnels = [];
    clients = [];
  });
  afterEach(async () => {
    for (const client of clients) client.terminate();
    for (const tunnel of tunnels) tunnel.close();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function target(handler: (socket: net.Socket) => void, socketPath?: string): Promise<string> {
    server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      handler(socket);
    });
    await new Promise<void>((resolve) =>
      socketPath ? server.listen(socketPath, resolve) : server.listen(0, '127.0.0.1', resolve),
    );
    return socketPath ?
        `${base}/?socketPath=${encodeURIComponent(socketPath)}`
      : `${base}/?target=127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  }
  async function tunnel(url: string): Promise<Tunnel> {
    const result = await startTcpTunnel(url, 'test-token', '127.0.0.1', 0, {
      mode: 'multiplexed',
      logLevel: 'none',
    });
    tunnels.push(result);
    return result;
  }
  async function connect(t: Tunnel): Promise<net.Socket> {
    const socket = net.connect({ host: '127.0.0.1', port: t.address.port, allowHalfOpen: true });
    sockets.add(socket);
    socket.on('error', () => {});
    await once(socket, 'connect');
    return socket;
  }
  async function ws(url: string, version?: string): Promise<WebSocket> {
    const socket = new WebSocket(url, version ? { headers: { [MUX_VERSION_HEADER]: version } } : {});
    clients.push(socket);
    await once(socket, 'open');
    return socket;
  }
  function bytes(socket: net.Socket, count: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let remaining = count;
      const timer = setTimeout(() => finish(new Error(`missing ${remaining} of ${count} bytes`)), 5000);
      function data(chunk: Buffer) {
        chunks.push(chunk);
        remaining -= chunk.length;
        if (remaining <= 0) finish();
      }
      function closed() {
        finish(new Error('closed before response completed'));
      }
      function finish(error?: Error) {
        clearTimeout(timer);
        socket.off('data', data);
        socket.off('close', closed);
        if (error) reject(error);
        else resolve(Buffer.concat(chunks));
      }
      socket.on('data', data);
      socket.once('close', closed);
      socket.resume();
    });
  }

  test.each([undefined, '1', '3'])(
    'old framing remains usable without negotiated v2 (%s)',
    async (version) => {
      const url = await target((socket) => socket.pipe(socket));
      const client = await ws(url, version);
      const response = once(client, 'message');
      client.send(Buffer.from([0, 0, 0, 1, 112, 105, 110, 103]));
      expect((await response)[0]).toEqual(Buffer.from([0, 0, 0, 1, 112, 105, 110, 103]));
    },
  );

  test('new framing carries concurrent binary transfers without crossing streams', async () => {
    const t = await tunnel(await target((socket) => socket.pipe(socket)));
    await Promise.all(
      [7, 99, 255].map(async (value) => {
        const socket = await connect(t),
          body = Buffer.alloc(MUX_WINDOW * 2 + 123, value);
        const response = bytes(socket, body.length);
        socket.write(body);
        expect(Buffer.compare(await response, body)).toBe(0);
        socket.destroy();
      }),
    );
  });

  test('TCP half-close preserves the response sent after request EOF', async () => {
    const t = await tunnel(
      await target((socket) => {
        const chunks: Buffer[] = [];
        socket.on('data', (data) => chunks.push(data));
        socket.on('end', () => socket.end(Buffer.concat(chunks)));
      }),
    );
    const client = await connect(t),
      body = Buffer.alloc(MUX_CHUNK * 3 + 11, 123);
    const response = bytes(client, body.length);
    client.end(body);
    expect(Buffer.compare(await response, body)).toBe(0);
    await once(client, 'close');
  });

  test('a stalled upload neither floods buffers nor stalls another stream', async () => {
    const t = await tunnel(
      await target((socket) => {
        socket.once('data', (data) => {
          if (data[0] === 0) socket.pause();
          else {
            socket.write(data);
            socket.pipe(socket);
          }
        });
      }),
    );
    const stalled = await connect(t);
    let accepted = 0;
    const chunk = Buffer.alloc(MUX_CHUNK);
    const produce = () => {
      while (!stalled.destroyed && accepted < 32 * MUX_WINDOW) {
        accepted += chunk.length;
        if (!stalled.write(chunk)) {
          stalled.once('drain', produce);
          return;
        }
      }
    };
    produce();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ping = await connect(t),
      response = bytes(ping, 4);
    ping.write('ping');
    expect((await response).toString()).toBe('ping');
    expect(accepted).toBeLessThan(16 * MUX_WINDOW);
  });

  test('a stalled download stops the producer while another stream remains usable', async () => {
    let produced = 0;
    const t = await tunnel(
      await target((socket) => {
        socket.once('data', (data) => {
          if (data[0] !== 0) {
            socket.write(data);
            socket.pipe(socket);
            return;
          }
          const produce = () => {
            while (!socket.destroyed && produced < 32 * MUX_WINDOW) {
              produced += MUX_CHUNK;
              if (!socket.write(Buffer.alloc(MUX_CHUNK))) {
                socket.once('drain', produce);
                return;
              }
            }
          };
          produce();
        });
      }),
    );
    const stalled = await connect(t);
    stalled.pause();
    stalled.write(Buffer.from([0]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ping = await connect(t),
      response = bytes(ping, 4);
    ping.write('ping');
    expect((await response).toString()).toBe('ping');
    expect(produced).toBeLessThan(16 * MUX_WINDOW);
  });

  test('reset releases connection slots for subsequent connections', async () => {
    const t = await tunnel(await target((socket) => socket.pipe(socket)));
    for (let i = 0; i < 80; i++) {
      const client = await connect(t),
        response = bytes(client, 4);
      client.write('ping');
      await response;
      client.destroy();
    }
  });

  test('invalid credit closes a negotiated session instead of changing dialect', async () => {
    const client = await ws(await target((socket) => socket.pipe(socket)), '2');
    const closed = once(client, 'close');
    client.send(muxFrame(MuxOp.open, 1));
    client.send(muxFrame(MuxOp.window, 1, Buffer.from([1, 0, 0, 0])));
    await closed;
  });

  (swift ? test : test.skip)('Web Inspector UNIX-socket forwarding uses the same flow control', async () => {
    const socketPath = path.join(os.tmpdir(), `lim-mux-${global.process.pid}.sock`);
    try {
      const t = await tunnel(await target((socket) => socket.pipe(socket), socketPath));
      const client = await connect(t);
      const body = Buffer.concat([Buffer.from('bplist00'), Buffer.alloc(2 * MUX_WINDOW, 42)]);
      const response = bytes(client, body.length);
      client.write(body);
      expect(Buffer.compare(await response, body)).toBe(0);
    } finally {
      fs.rmSync(socketPath, { force: true });
    }
  });
});
