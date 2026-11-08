import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Signaling, type Message } from './internal/serve-sim/signaling';
import { createInstanceClient, type FoldState, type FoldDisplay } from './ios-client';

export interface ServeSimDevice {
  platform: 'ios' | 'android';
  endpoint: string;
  apiUrl: string;
  /** Mint a watch token for viewing. Never return the interactive token for this grant. */
  token: (grant: 'watch' | 'stream') => Promise<string>;
}

export interface ServeSimAdapterOptions {
  /** Resolve only devices owned by this host. An unknown or ended instance returns undefined. */
  resolveDevice: (id: string) => Promise<ServeSimDevice | undefined>;
}

const orientations = {
  portrait: 'portrait',
  portrait_upside_down: 'pud',
  landscape_left: 'landscape-left',
  landscape_right: 'landscape-right',
} as const;
type Orientation = keyof typeof orientations;
const turns = (value: number) =>
  value === 2 ? 2
  : value === 3 ? 1
  : value === 4 ? 3
  : 0;
const tagged = (tag: number, value?: unknown) =>
  Buffer.concat([Buffer.from([tag]), ...(value === undefined ? [] : [Buffer.from(JSON.stringify(value))])]);
const key = (code: number, action: number) => {
  const b = Buffer.alloc(14);
  b[1] = action;
  b.writeInt32LE(code, 2);
  return b;
};
const point = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error('Invalid normalized coordinate');
  return value;
};

function touch(action: number, x: number, y: number, display?: FoldDisplay): Buffer {
  if (display) {
    const b = Buffer.alloc(12);
    b[0] = 19;
    b[1] = action;
    b[2] = display.screenId;
    b.writeFloatLE(x, 4);
    b.writeFloatLE(y, 8);
    return b;
  }
  const b = Buffer.alloc(32);
  b[0] = 2;
  b[1] = action;
  b.writeInt32LE(Math.round(x * 10000), 10);
  b.writeInt32LE(Math.round(y * 10000), 14);
  b.writeUInt16LE(10000, 18);
  b.writeUInt16LE(10000, 20);
  b.writeUInt16LE(action === 1 ? 0 : 65535, 22);
  return b;
}

async function body(request: IncomingMessage): Promise<Message> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

function route(url: URL): { id: string; path: string; panel?: 'outer' | 'inner' } | undefined {
  const helper = /^\/vendor\/serve-sim\/helper\/([^/]+)(?:\/panel\/(1|3))?\/(.+)$/.exec(url.pathname);
  const panel = helper?.[2] ?? url.searchParams.get('panel');
  if (helper)
    return {
      id: decodeURIComponent(helper[1]!),
      path: helper[3]!,
      ...(panel ? { panel: panel === '1' ? ('outer' as const) : ('inner' as const) } : {}),
    };
  const id = url.searchParams.get('device');
  if (!id) return undefined;
  return {
    id,
    path: url.pathname.replace(/^\/vendor\/serve-(sim|emu)\//, ''),
    ...(url.searchParams.get('panel') === '1' ? { panel: 'outer' as const }
    : url.searchParams.get('panel') === '3' ? { panel: 'inner' as const }
    : {}),
  };
}

/** A loopback provider hub. Media flows directly between the browser and Limrun. */
export async function createServeSimAdapter(options: ServeSimAdapterOptions) {
  const secret = randomUUID();
  const peers = new Map<string, Signaling>();
  const connections = new Set<Signaling>();
  const logs = new Map<string, Promise<{ events: Message[]; close: () => void }>>();
  const eventLog = (id: string, device: ServeSimDevice) => {
    let pending = logs.get(id);
    if (!pending) {
      pending = (async () => {
        const client = await createInstanceClient({
          apiUrl: device.apiUrl,
          token: await device.token('stream'),
          logLevel: 'none',
        });
        try {
          await client.startEventCapture();
          const events: Message[] = [];
          let sequence = 0;
          const stop = client.streamEventCapture({
            onEvent: (event) => {
              events.push({
                id: ++sequence,
                timestamp: new Date(event.ts).toISOString(),
                kind: event.type,
                summary: event.summary ?? event.type,
              });
              if (events.length > 100) events.shift();
            },
          });
          return {
            events,
            close: () => {
              stop();
              client.disconnect();
            },
          };
        } catch (error) {
          client.disconnect();
          throw error;
        }
      })();
      logs.set(id, pending);
      void pending.catch(() => {
        if (logs.get(id) === pending) logs.delete(id);
      });
    }
    return pending;
  };
  const inputs = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const authorized = (request: IncomingMessage) => {
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${secret}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const connect = async (device: ServeSimDevice, grant: 'watch' | 'stream') => {
    const signal = new Signaling(device.endpoint, await device.token(grant));
    connections.add(signal);
    signal.ws.once('close', () => connections.delete(signal));
    try {
      await signal.open();
      return signal;
    } catch (error) {
      signal.close();
      connections.delete(signal);
      throw error;
    }
  };
  const json = (response: ServerResponse, status: number, data: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (!authorized(request)) return json(response, 401, { error: 'Unauthorized' });
      const url = new URL(request.url!, 'http://localhost');
      const target = route(url);
      if (!target) return json(response, 404, { error: 'Unknown route' });
      const device = await options.resolveDevice(target.id);
      if (!device) return json(response, 404, { error: 'Device has ended' });
      if (request.method === 'GET' && target.path.startsWith('api/event-log') && device.platform === 'ios') {
        const log = await eventLog(target.id, device);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.end(`retry: 1000\ndata: ${JSON.stringify({ events: log.events })}\n\n`);
        return;
      }
      if (request.method === 'GET' && target.path === 'foreground') return json(response, 200, null);
      if (target.path === 'stream.avcc' || target.path === 'stream.mjpeg')
        return json(response, 409, { error: 'stream_transport_locked', transport: 'webrtc' });
      if (target.path === 'webrtc/close' && request.method === 'POST') {
        const input = await body(request);
        const id = `${target.id}:${input['sessionId']}`;
        peers.get(id)?.close();
        peers.delete(id);
        return json(response, 200, {});
      }
      if (
        request.method !== 'GET' &&
        !(request.method === 'POST' && ['webrtc/offer', 'api/screenshot'].includes(target.path))
      )
        return json(response, 405, { error: 'Method not allowed' });
      const signal = await connect(device, 'watch');
      let retained = false;
      const abort = () => {
        if (!response.writableEnded) signal.close();
      };
      response.once('close', abort);
      try {
        if (target.path === 'api') {
          const config = await signal.configuration();
          return json(response, 200, {
            streamSettings: {
              ...config['rtcConfiguration'],
              transport: 'webrtc',
              iceTransportPolicy: 'relay',
            },
          });
        }
        if (target.path === 'webrtc/offer') {
          const input = await body(request);
          if (
            input['type'] !== 'offer' ||
            typeof input['sdp'] !== 'string' ||
            typeof input['sessionId'] !== 'string' ||
            input['sessionId'].length > 128
          )
            return json(response, 400, { error: 'Invalid offer' });
          const id = `${target.id}:${input['sessionId']}`;
          if (peers.has(id)) return json(response, 409, { error: 'Session already exists' });
          await signal.configuration();
          const sdp = await signal.offer(input['sdp'], target.panel ?? 'active');
          if (response.destroyed) return;
          peers.set(id, signal);
          retained = true;
          signal.ws.once('close', () => {
            if (peers.get(id) === signal) peers.delete(id);
          });
          return json(response, 200, { type: 'answer', sdp });
        }
        if (target.path === 'api/screenshot') {
          let display = target.panel;
          if (device.platform === 'ios' && !display) {
            const state = (await signal.request('getFoldState'))['state'] as FoldState | undefined;
            if (state) display = state.angleDegrees < 90 ? 'outer' : 'inner';
          }
          const shot = await signal.request(display ? 'screenshotDisplay' : 'screenshot', {
            format: 'png',
            ...(display ? { display } : {}),
          });
          const payload = shot['payload'] ?? shot;
          const data = payload['base64'] ?? payload['dataUri']?.split(',')[1];
          if (typeof data !== 'string') throw new Error('Invalid screenshot response');
          response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          response.end(Buffer.from(data, 'base64'));
          return;
        }
        if (target.path === 'ax' || target.path === 'api/accessibility') {
          const result = await signal.request('elementTree');
          return json(
            response,
            200,
            typeof result['json'] === 'string' ? JSON.parse(result['json']) : result['payload'] ?? result,
          );
        }
        if (['config', 'health'].includes(target.path))
          return json(response, 200, await signal.request('deviceInfo'));
        return json(response, 404, { error: 'Unsupported helper route' });
      } finally {
        response.off('close', abort);
        if (!retained) signal.close();
      }
    })().catch(() => {
      if (!response.headersSent) json(response, 502, { error: 'Simulator request failed' });
      else response.destroy();
    });
  });
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      if (!authorized(request)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      const url = new URL(request.url!, 'http://localhost');
      const target = route(url);
      if (!target || !['helper/ws', 'ws'].includes(target.path)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      const device = await options.resolveDevice(target.id);
      if (!device) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      const signal = await connect(device, 'stream');
      try {
        await signal.configuration();
        if (socket.destroyed) {
          signal.close();
          return;
        }
        inputs.handleUpgrade(request, socket, head, (client) => {
          void attachInput(client, signal, device.platform).catch(() => {
            client.close(1011, 'Input unavailable');
            signal.close();
          });
        });
      } catch (error) {
        signal.close();
        throw error;
      }
    })().catch(() => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Adapter did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    headers: { authorization: `Bearer ${secret}` },
    async close(): Promise<void> {
      for (const client of inputs.clients) client.terminate();
      for (const signal of connections) signal.close();
      peers.clear();
      inputs.close();
      for (const log of logs.values()) {
        try {
          (await log).close();
        } catch {
          /* Failed initialization already disconnects. */
        }
      }
      logs.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function attachInput(client: WebSocket, signal: Signaling, platform: 'ios' | 'android'): Promise<void> {
  let fold: FoldState | undefined;
  let orientation: Orientation = 'portrait';
  let width = 10000;
  let height = 10000;
  let held: { x: number; y: number; display?: FoldDisplay } | undefined;
  const release = () => {
    if (held) {
      signal.send(touch(1, held.x, held.y, held.display));
      held = undefined;
    }
  };
  const display = () =>
    fold?.displays.find((item) => item.id === (fold!.angleDegrees < 90 ? 'outer' : 'inner'));
  const configure = () => {
    const active = display();
    if (active) {
      width = active.width;
      height = active.height;
      orientation = (['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'] as const)[
        turns(active.orientation)
      ]!;
    }
    client.send(
      tagged(0x82, {
        width,
        height,
        orientation,
        ...(active ?
          {
            screenId: active.id === 'outer' ? 1 : 3,
            hingeAngle: fold!.angleDegrees,
            supportsHingeAngle: true,
            supportsPhysicalOrientation: false,
            tableModeAvailable: false,
          }
        : {}),
      }),
    );
  };
  client.once('close', () => {
    release();
    signal.close();
  });
  signal.ws.once('close', () => client.close(1011, 'Simulator disconnected'));
  signal.subscribe((message) => {
    if (message['type'] === 'foldStateChanged') {
      release();
      fold = message['state'];
      configure();
    }
  });
  if (platform === 'ios') {
    const info = await signal.request('deviceInfo');
    width = info['screenWidth'];
    height = info['screenHeight'];
    fold = (await signal.request('getFoldState'))['state'];
    if (client.readyState !== WebSocket.OPEN) return;
    configure();
    client.send(tagged(0x83));
  }
  let queue = Promise.resolve();
  let queued = 0;
  client.on('message', (data, binary) => {
    if (++queued > 256) {
      client.close(1008, 'Input queue exceeded');
      return;
    }
    queue = queue
      .then(async () => {
        if (client.readyState !== WebSocket.OPEN) return;
        const bytes = Buffer.from(data as Buffer);
        const tag = binary ? bytes[0] : undefined;
        const value: Message = JSON.parse(binary ? bytes.subarray(1).toString() : bytes.toString());
        if (tag === 3 || value['type'] === 'touch') {
          const phase = value['type'] === 'touch' ? value['action'] : value['type'];
          const action =
            phase === 'begin' || phase === 'down' ? 0
            : phase === 'move' ? 2
            : phase === 'end' || phase === 'up' ? 1
            : -1;
          if (action < 0) throw new Error('Invalid touch phase');
          const x = point(value['x']);
          const y = point(value['y']);
          if (action === 0) {
            release();
            held = { x, y, ...(display() ? { display: display()! } : {}) };
          }
          if (!held) return;
          held.x = x;
          held.y = y;
          signal.send(touch(action, x, y, held.display));
          if (action === 1) held = undefined;
        } else if (tag === 6) {
          if (!Number.isInteger(value['usage']) || !['down', 'up'].includes(value['type']))
            throw new Error('Invalid key');
          await signal.request('performActions', {
            actions: [{ type: value['type'] === 'down' ? 'keyDown' : 'keyUp', keyCode: value['usage'] }],
          });
        } else if (tag === 7 || tag === 16) {
          release();
          try {
            const command = value['command'];
            if (tag === 16 && command?.control === 'angle') {
              const angle = command.value;
              if (!Number.isFinite(angle) || angle < 0 || angle > 180) throw new Error('Invalid angle');
              fold = (await signal.request('setHingeAngle', { angleDegrees: angle }))['state'];
            } else {
              const next = value['orientation'];
              if (!(next in orientations)) throw new Error('Invalid orientation');
              await signal.request(fold ? 'setDuoOrientation' : 'setOrientation', {
                orientation: fold ? orientations[next as Orientation] : next,
              });
              orientation = next;
              if (fold) fold = (await signal.request('getFoldState'))['state'];
            }
            configure();
            if (tag === 16) client.send(tagged(0x90, { requestId: value['requestId'], ok: true }));
          } catch {
            client.send(
              tagged(0x90, { requestId: value['requestId'], ok: false, error: 'Device control failed' }),
            );
          }
        } else if (value['type'] === 'text') {
          if (typeof value['text'] !== 'string') throw new Error('Invalid text');
          const text = Buffer.from(value['text']);
          const message = Buffer.alloc(5 + text.length);
          message[0] = 1;
          message.writeUInt32BE(text.length, 1);
          text.copy(message, 5);
          signal.send(message);
        } else {
          const code =
            tag === 4 ? ({ home: 3, app_switcher: 187, lock: 26 } as Record<string, number>)[value['button']]
            : value['type'] === 'key' ? value['keycode']
            : ({ home: 3, back: 4, recents: 187, power: 26 } as Record<string, number>)[value['type']];
          if (!Number.isInteger(code)) throw new Error('Unsupported input');
          signal.send(key(code, 0));
          signal.send(key(code, 1));
        }
      })
      .catch(() => client.close(1008, 'Invalid input'))
      .finally(() => queued--);
  });
}
