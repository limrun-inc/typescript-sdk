import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createServeSimAdapter } from '../src/serve-sim';
import { gatherAnswer } from '../src/internal/serve-sim/signaling';

const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n';
const fold = {
  angleDegrees: 180,
  orientation: 'portrait',
  minAngleDegrees: 0,
  maxAngleDegrees: 180,
  displays: [
    { id: 'outer', width: 800, height: 1600, scale: 2, screenId: 9, orientation: 1 },
    { id: 'inner', width: 1600, height: 1800, scale: 2, screenId: 17, orientation: 1 },
  ],
};

async function fixture(platform: 'ios' | 'android' = 'ios', compatibilityVersion = 1) {
  const runtime = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(runtime, 'listening');
  const messages: Array<{ token: string; message: any }> = [];
  let refuseWatch = false;
  runtime.on('connection', (socket, request) => {
    const token = request.headers.authorization!;
    socket.on('message', (data, binary) => {
      if (binary) {
        messages.push({ token, message: Buffer.from(data as Buffer) });
        return;
      }
      const message = JSON.parse(data.toString());
      messages.push({ token, message });
      const send = (value: any) => socket.send(JSON.stringify(value));
      switch (message.type) {
        case 'requestRtcConfiguration':
          send({
            type: 'rtcConfiguration',
            compatibilityVersion,
            rtcConfiguration: { iceServers: [{ urls: 'turn:test', username: 'test', credential: 'test' }] },
            foldSupported: true,
          });
          break;
        case 'offer':
          send({
            type: 'candidate',
            candidate: 'candidate:1 1 udp 1 192.0.2.1 1234 typ relay',
            sdpMid: '0',
            sdpMLineIndex: 0,
          });
          send({ type: 'answer', sdp });
          send({ type: 'candidate', candidate: '' });
          break;
        case 'deviceInfo':
          send({ type: 'deviceInfoResult', id: message.id, screenWidth: 400, screenHeight: 800 });
          break;
        case 'getFoldState':
          send({ type: 'foldStateResult', id: message.id, state: fold });
          break;
        case 'setHingeAngle':
          send({ type: 'foldStateChanged', state: { ...fold, angleDegrees: message.angleDegrees } });
          send({ id: message.id, state: { ...fold, angleDegrees: message.angleDegrees } });
          break;
        case 'getElementTree':
          send({ id: message.id, payload: { xml: '<hierarchy/>' } });
          break;
        case 'screenshot':
          send({ id: message.id, payload: { dataUri: 'data:image/png;base64,aW1hZ2U=' } });
          break;
        case 'elementTree':
          send({ id: message.id, json: '{"children":[]}' });
          break;
        case 'screenshotDisplay':
          send({ id: message.id, base64: 'aW1hZ2U=' });
          break;
        case 'performActions':
          send({ id: message.id, results: [] });
          break;
      }
    });
  });
  const address = runtime.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected address');
  const hub = await createServeSimAdapter({
    resolveDevice: async (id) =>
      id === 'owned' ?
        {
          platform,
          endpoint: `ws://127.0.0.1:${address.port}`,
          apiUrl: 'http://unused',
          token: async (grant) => {
            if (grant === 'watch' && refuseWatch) throw new Error('Denied');
            return grant;
          },
        }
      : undefined,
  });
  return {
    hub,
    runtime,
    messages,
    refuseWatch: () => {
      refuseWatch = true;
    },
    close: async () => {
      await hub.close();
      for (const socket of runtime.clients) socket.terminate();
      await new Promise<void>((resolve) => runtime.close(() => resolve()));
    },
  };
}

it('keeps simultaneous viewers isolated and aggregates candidates without exposing control credentials', async () => {
  const f = await fixture();
  try {
    const api = await fetch(`${f.hub.origin}/vendor/serve-sim/api?device=owned`, { headers: f.hub.headers });
    expect(((await api.json()) as any).streamSettings.iceTransportPolicy).toBe('relay');
    const replies = await Promise.all(
      ['1', '3'].map((panel) =>
        fetch(`${f.hub.origin}/vendor/serve-sim/helper/owned/webrtc/offer?panel=${panel}`, {
          method: 'POST',
          headers: { ...f.hub.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'offer', sdp, sessionId: panel }),
        }),
      ),
    );
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect(((await reply.json()) as any).sdp).toContain('a=candidate:1');
    }
    const offers = f.messages.filter((item) => item.message.type === 'offer');
    expect(offers.map((item) => item.message.display).sort()).toEqual(['inner', 'outer']);
    expect(new Set(offers.map((item) => item.message.sessionId)).size).toBe(2);
    expect(f.messages.every((item) => item.token === 'Bearer watch')).toBe(true);
    const disconnected = [...f.runtime.clients].map((socket) => once(socket, 'close'));
    await f.hub.releaseDevice('owned');
    await Promise.all(disconnected);
    expect(f.runtime.clients.size).toBe(0);
    const denied = await fetch(`${f.hub.origin}/vendor/serve-sim/api?device=owned`);
    expect(denied.status).toBe(401);
    const missing = await fetch(`${f.hub.origin}/vendor/serve-sim/api?device=other`, {
      headers: f.hub.headers,
    });
    expect(missing.status).toBe(404);
    f.refuseWatch();
    const refused = await fetch(`${f.hub.origin}/vendor/serve-sim/api?device=owned`, {
      headers: f.hub.headers,
    });
    expect(refused.status).toBe(502);
    expect(f.messages.every((item) => item.token === 'Bearer watch')).toBe(true);
  } finally {
    await f.close();
  }
});

it('routes Duo touches to native display IDs and releases a held gesture before folding', async () => {
  const f = await fixture();
  try {
    const socket = new WebSocket(
      `${f.hub.origin.replace('http:', 'ws:')}/vendor/serve-sim/helper/ws?device=owned`,
      { headers: f.hub.headers },
    );
    const admitted = new Promise<void>((resolve) =>
      socket.on('message', (data) => {
        if (Buffer.from(data as Buffer)[0] === 0x83) resolve();
      }),
    );
    await admitted;
    const send = (tag: number, value: any) =>
      socket.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(value))]));
    send(3, { type: 'begin', x: 0.25, y: 0.75 });
    const ack = new Promise<any>((resolve) =>
      socket.on('message', (data) => {
        const bytes = Buffer.from(data as Buffer);
        if (bytes[0] === 0x90) resolve(JSON.parse(bytes.subarray(1).toString()));
      }),
    );
    send(16, { requestId: 1, command: { control: 'angle', value: 0 } });
    expect(await ack).toEqual({ requestId: 1, ok: true });
    const inputs = f.messages.filter((item) => Buffer.isBuffer(item.message));
    expect(inputs.map((item) => [item.message[0], item.message[1], item.message[2]])).toEqual([
      [19, 0, 17],
      [19, 1, 17],
    ]);
    expect(inputs.every((item) => item.token === 'Bearer stream')).toBe(true);
    socket.close();
    await once(socket, 'close');
  } finally {
    await f.close();
  }
});

it('serves active-display screenshots and AX through watch credentials', async () => {
  const f = await fixture();
  try {
    const shot = await fetch(`${f.hub.origin}/vendor/serve-sim/api/screenshot?device=owned`, {
      method: 'POST',
      headers: f.hub.headers,
    });
    expect(await shot.text()).toBe('image');
    expect(f.messages.find((item) => item.message.type === 'screenshotDisplay')?.message.display).toBe(
      'inner',
    );
    const ax = await fetch(`${f.hub.origin}/vendor/serve-sim/helper/owned/ax`, { headers: f.hub.headers });
    expect(await ax.json()).toEqual({ children: [] });
    expect(f.messages.every((item) => item.token === 'Bearer watch')).toBe(true);
  } finally {
    await f.close();
  }
});

it('places candidates in their matching media section', () => {
  const answer = gatherAnswer(sdp + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\n', [
    { sdpMid: 'audio', sdpMLineIndex: 1, candidate: 'candidate:audio' },
  ]);
  expect(answer.indexOf('m=audio')).toBeLessThan(answer.indexOf('a=candidate:audio'));
  expect(answer.match(/a=candidate:audio/g)).toHaveLength(1);
});

it('serves Android watch reads and translates its independent input socket', async () => {
  const f = await fixture('android');
  try {
    const ax = await fetch(`${f.hub.origin}/vendor/serve-emu/api/accessibility?device=owned`, {
      headers: f.hub.headers,
    });
    expect(await ax.json()).toEqual({ xml: '<hierarchy/>' });
    const shot = await fetch(`${f.hub.origin}/vendor/serve-emu/api/screenshot?device=owned`, {
      headers: f.hub.headers,
    });
    expect(await shot.text()).toBe('image');
    expect(f.messages.every((item) => item.token === 'Bearer watch')).toBe(true);
    const received = new Promise<void>((resolve) => {
      f.runtime.on('connection', (socket) =>
        socket.on('message', (_data, binary) => {
          if (binary && f.messages.filter((item) => Buffer.isBuffer(item.message)).length === 5) resolve();
        }),
      );
    });
    const socket = new WebSocket(
      `${f.hub.origin.replace('http:', 'ws:')}/vendor/serve-emu/ws?device=owned&video=0`,
      { headers: f.hub.headers },
    );
    await once(socket, 'open');
    for (const value of [
      { type: 'touch', action: 'down', x: 0.2, y: 0.8 },
      { type: 'touch', action: 'up', x: 0.2, y: 0.8 },
      { type: 'text', text: 'Hello' },
      { type: 'home' },
    ])
      socket.send(JSON.stringify(value));
    await received;
    const controls = f.messages.filter((item) => Buffer.isBuffer(item.message));
    expect(controls.map((item) => item.message[0])).toEqual([2, 2, 1, 0, 0]);
    expect(controls[0]!.message.readInt32LE(10)).toBe(2000);
    expect(controls[0]!.message.readInt32LE(14)).toBe(8000);
    expect(controls[2]!.message.subarray(5).toString()).toBe('Hello');
    expect(controls[3]!.message.readInt32LE(2)).toBe(3);
    expect(controls.every((item) => item.token === 'Bearer stream')).toBe(true);
    socket.close();
    await once(socket, 'close');
  } finally {
    await f.close();
  }
});

it('rejects runtimes without compatibility support and invalid panel IDs', async () => {
  const f = await fixture('ios', 0);
  try {
    const old = await fetch(`${f.hub.origin}/vendor/serve-sim/api?device=owned`, { headers: f.hub.headers });
    expect(old.status).toBe(502);
    const panel = await fetch(`${f.hub.origin}/vendor/serve-sim/helper/owned/webrtc/offer?panel=2`, {
      method: 'POST',
      headers: f.hub.headers,
    });
    expect(panel.status).toBe(404);
    expect(f.messages.some((item) => item.message.type === 'offer')).toBe(false);
  } finally {
    await f.close();
  }
});

it('reserves a viewer ID during negotiation and closes it explicitly', async () => {
  const f = await fixture();
  try {
    const request = () =>
      fetch(`${f.hub.origin}/vendor/serve-sim/helper/owned/webrtc/offer`, {
        method: 'POST',
        headers: f.hub.headers,
        body: JSON.stringify({ type: 'offer', sdp, sessionId: 'same' }),
      });
    const replies = await Promise.all([request(), request()]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(f.messages.filter((item) => item.message.type === 'offer')).toHaveLength(1);
    const close = await fetch(`${f.hub.origin}/vendor/serve-sim/helper/owned/webrtc/close`, {
      method: 'POST',
      headers: f.hub.headers,
      body: JSON.stringify({ sessionId: 'same' }),
    });
    expect(close.status).toBe(200);
    expect((await request()).status).toBe(200);
  } finally {
    await f.close();
  }
});
