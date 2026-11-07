import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceStream, type DeviceStream } from './device-stream';
import { attachVideoStream } from './video-playback';
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RemoteControl,
  type RemoteControlHandle,
  type RemoteControlProps,
} from '../components/remote-control';
import { CONTROL_MSG_TYPE, axElementAtPoint, axElementSelectorExpression, normalizeIosTree } from '../core';

vi.mock('./video-playback', () => ({
  attachVideoStream: vi.fn((video, stream) => {
    video.srcObject = stream;
    return vi.fn();
  }),
}));

class Socket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static sockets: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: Record<string, any>[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(readonly url: string) {
    super();
    Socket.sockets.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(message: object) {
    const event = new MessageEvent('message', { data: JSON.stringify(message) });
    this.dispatchEvent(event);
    this.onmessage?.(event);
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}
class Stream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}
class Peer extends EventTarget {
  static peers: Peer[] = [];
  connectionState = 'new';
  iceConnectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  transceivers: any[] = [];
  channel = {
    readyState: 'connecting',
    onopen: null as (() => void) | null,
    onclose: null,
    onerror: null,
    close: vi.fn(),
    send: vi.fn(),
  };
  remoteDescription: unknown;
  close = vi.fn();
  getStats = vi.fn(
    async () =>
      new Map([
        [
          'video',
          {
            id: 'video',
            type: 'inbound-rtp',
            kind: 'video',
            timestamp: Date.now(),
            framesDecoded: Date.now() / 20,
          },
        ],
      ]) as unknown as RTCStatsReport,
  );
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async (value) => {
    this.remoteDescription = value;
  });
  addIceCandidate = vi.fn(async () => {});
  createDataChannel = vi.fn(() => this.channel);
  getTransceivers = () => this.transceivers;
  constructor(readonly configuration: RTCConfiguration) {
    super();
    Peer.peers.push(this);
  }
  addTransceiver(kind: string, options: { direction: string }) {
    const transceiver = {
      direction: options.direction,
      currentDirection: options.direction,
      receiver: {
        track: { kind, id: `${kind}${this.transceivers.length}`, readyState: 'live' },
        jitterBufferTarget: 0,
      },
      sender: {
        replaceTrack: vi.fn(async () => {}),
        getParameters: () => ({ encodings: [{}] }),
        setParameters: vi.fn(async () => {}),
      },
      setCodecPreferences: vi.fn(),
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  fail() {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }
  connected() {
    this.channel.readyState = 'open';
    this.channel.onopen?.();
  }
  track(id = 'video0') {
    const track = { kind: 'video', id } as MediaStreamTrack;
    const stream = new Stream([track]);
    this.ontrack?.({
      track,
      streams: [stream],
      receiver: this.transceivers[1].receiver,
    } as unknown as RTCTrackEvent);
    return stream;
  }
}
const clients: DeviceStream[] = [];
let mountedRoot: ReturnType<typeof createRoot> | undefined;
function create(
  options: Parameters<typeof createDeviceStream>[0] = { url: 'wss://host/ios_test', token: 'secret' },
) {
  const client = createDeviceStream(options);
  clients.push(client);
  return client;
}
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
async function handshake(client?: DeviceStream, config: object = {}) {
  client?.start();
  await flush();
  const socket = Socket.sockets.at(-1)!;
  socket.open();
  await flush();
  socket.message({ type: 'rtcConfiguration', rtcConfiguration: { iceServers: [] }, ...config });
  await flush();
  return { socket, peer: Peer.peers.at(-1)! };
}
beforeEach(() => {
  vi.useFakeTimers();
  Socket.sockets = [];
  Peer.peers = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal(
    'RTCSessionDescription',
    class {
      constructor(value: object) {
        Object.assign(this, value);
      }
    },
  );
  vi.stubGlobal(
    'RTCIceCandidate',
    class {
      constructor(value: object) {
        Object.assign(this, value);
      }
    },
  );
  vi.stubGlobal('RTCRtpReceiver', {
    getCapabilities: () => ({
      codecs: ['VP8', 'H264', 'H265', 'VP9'].map((v) => ({ mimeType: `video/${v}` })),
    }),
  });
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [] }) });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot!.unmount());
  mountedRoot = undefined;
  document.body.replaceChildren();
  clients.splice(0).forEach((client) => client.dispose());
  await flush();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function respondWithTree(socket: Socket) {
  const request = socket.sent.filter((message) => message.type === 'elementTree').at(-1)!;
  socket.message({
    type: 'elementTreeResult',
    id: request.id,
    json: JSON.stringify([
      {
        frame: { x: 0, y: 0, width: 100, height: 200 },
        type: 'Application',
        children: [
          {
            frame: { x: 10, y: 10, width: 50, height: 50 },
            type: 'Button',
            AXLabel: 'Continue',
            AXUniqueId: 'continue',
          },
        ],
      },
    ]),
  });
}

describe('headless device stream', () => {
  it.each(['retry gap', 'pending transport'])(
    'keeps a visible session alive after visibility changes during %s',
    async (phase) => {
      let finishConnect!: (socket: WebSocket) => void;
      const connect = vi.fn<() => WebSocket | Promise<WebSocket>>(
        () => new Socket('wss://proxy') as unknown as WebSocket,
      );
      const client = create({ platform: 'ios', autoReconnect: true, transport: { connect } });
      const { peer } = await handshake(client);
      peer.connected();
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      peer.fail();
      if (phase === 'pending transport') {
        connect.mockImplementationOnce(
          () =>
            new Promise<WebSocket>((resolve) => {
              finishConnect = resolve;
            }),
        );
        await vi.advanceTimersByTimeAsync(1000);
      }
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      document.dispatchEvent(new Event('visibilitychange'));
      if (phase === 'pending transport') {
        finishConnect(new Socket('wss://proxy') as unknown as WebSocket);
        await flush();
      } else await vi.advanceTimersByTimeAsync(1000);
      const replacement = Socket.sockets.at(-1)!;
      replacement.open();
      await flush();
      replacement.message({ type: 'rtcConfiguration', rtcConfiguration: { iceServers: [] } });
      await flush();
      Peer.peers.at(-1)!.connected();
      await vi.advanceTimersByTimeAsync(20000);
      expect(replacement.sent.filter((message) => message.type === 'keepAlive')).toHaveLength(2);
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(20000);
      expect(replacement.sent.filter((message) => message.type === 'keepAlive')).toHaveLength(2);
    },
  );

  it('honors a slow termination verdict after retries exhaust', async () => {
    let finishProbe!: (result: boolean) => void;
    const isTerminated = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const onTerminated = vi.fn();
    const client = create({
      platform: 'ios',
      autoReconnect: true,
      onTerminated,
      transport: {
        connect: () => new Socket('wss://proxy') as unknown as WebSocket,
        isTerminated,
      },
    });
    const { peer } = await handshake(client);
    peer.connected();
    peer.fail();
    // Open each retry socket, then fail its RTC configuration request before the probe returns.
    for (let attempt = 0; attempt < 3; attempt++) {
      await vi.advanceTimersByTimeAsync(1000);
      const socket = Socket.sockets.at(-1)!;
      socket.open();
      await flush();
      const request = socket.sent.find((message) => message.type === 'requestRtcConfiguration')!;
      socket.message({
        type: 'signalingError',
        requestType: 'requestRtcConfiguration',
        sessionId: request.sessionId,
        error: 'gone',
      });
      await flush();
    }
    expect(client.getState().connection).toBe('failed');
    expect(isTerminated).toHaveBeenCalledOnce();
    finishProbe(true);
    await flush();
    expect(client.getState().connection).toBe('terminated');
    expect(onTerminated).toHaveBeenCalledOnce();
  });

  it('isolates termination probes across an explicit restart', async () => {
    const probes: ((value: boolean) => void)[] = [];
    const isTerminated = vi.fn(() => new Promise<boolean>((resolve) => probes.push(resolve)));
    const client = create({
      platform: 'ios',
      autoReconnect: true,
      transport: { connect: () => new Socket('wss://proxy') as unknown as WebSocket, isTerminated },
    });
    const first = await handshake(client);
    first.peer.connected();
    first.peer.fail();
    client.stop();
    const second = await handshake(client);
    second.peer.connected();
    second.peer.fail();
    expect(isTerminated).toHaveBeenCalledTimes(2);
    probes[0](true);
    await flush();
    expect(client.getState().connection).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    const third = Socket.sockets.at(-1)!;
    third.drop();
    await flush();
    expect(isTerminated).toHaveBeenCalledTimes(2);
    probes[1](true);
    await flush();
    expect(client.getState().connection).toBe('terminated');
  });

  it.each([false, true])(
    'preserves playing WebRTC after signaling closes with autoReconnect=%s',
    async (autoReconnect) => {
      const client = create({ url: 'wss://host/ios_test', token: 'secret', autoReconnect });
      const video = document.createElement('video');
      client.attachVideo(video);
      const { socket, peer } = await handshake(client);
      peer.connected();
      const stream = peer.track();
      video.dispatchEvent(new Event('loadeddata'));
      socket.drop();
      await vi.advanceTimersByTimeAsync(20000);
      expect(client.getState()).toMatchObject({
        connection: 'connected',
        videoReady: true,
        controlReady: true,
      });
      expect(video.srcObject).toBe(stream);
      expect(peer.close).not.toHaveBeenCalled();
      expect(Socket.sockets).toHaveLength(1);
      client.pressButton('home');
      expect(peer.channel.send).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['stop', 'reconnect', 'drop', 'dispose'] as const)(
    'clears the accessibility snapshot on %s',
    async (action) => {
      const onAxSnapshotChange = vi.fn();
      const client = create({
        url: 'wss://host/ios_test',
        token: 'secret',
        inspectMode: true,
        onAxSnapshotChange,
      });
      const { socket, peer } = await handshake(client);
      peer.connected();
      respondWithTree(socket);
      await flush();
      vi.runAllTicks();
      expect(onAxSnapshotChange.mock.lastCall![0].elements).toHaveLength(1);
      onAxSnapshotChange.mockClear();
      if (action === 'drop') peer.fail();
      else client[action]();
      await flush();
      vi.runAllTicks();
      expect(client.getAxSnapshot()).toBeNull();
      expect(onAxSnapshotChange.mock.calls).toEqual([[null]]);
    },
  );

  it('discards a queued snapshot when inspection stops and emits one clear notification', async () => {
    const queued: VoidFunction[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => queued.push(callback));
    const onAxSnapshotChange = vi.fn();
    const client = create({
      url: 'wss://host/ios_test',
      token: 'secret',
      inspectMode: true,
      onAxSnapshotChange,
    });
    const { socket, peer } = await handshake(client);
    peer.connected();
    respondWithTree(socket);
    await flush();
    expect(client.getAxSnapshot()?.elements).toHaveLength(1);
    client.updateOptions({ inspectMode: false });
    client.updateOptions({ inspectMode: false, autoReconnect: true });
    queued.forEach((callback) => callback());
    expect(onAxSnapshotChange.mock.calls).toEqual([[null]]);
  });

  it('keeps stats cadence and deltas across callback and live option updates', async () => {
    const first = vi.fn();
    const next = vi.fn();
    const client = create({ url: 'wss://host/ios_test', token: 'secret', onPlaybackStats: first });
    const { peer } = await handshake(client);
    peer.connectionState = 'connected';
    peer.dispatchEvent(new Event('connectionstatechange'));
    await flush();
    expect(first.mock.lastCall![0].video[0].fps).toBeUndefined();
    client.updateOptions({
      onPlaybackStats: next,
      jitterBufferTargetMs: 10,
      autoReconnect: true,
      microphoneEnabled: false,
      inspectMode: false,
    });
    await flush();
    expect(peer.getStats).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(next.mock.lastCall![0]).toMatchObject({
      requestedTargetMs: 10,
      video: [{ intervalMs: 2000, fps: 50 }],
    });
    expect(first).toHaveBeenCalledTimes(1);
    client.updateOptions({ onPlaybackStats: undefined });
    await vi.advanceTimersByTimeAsync(2000);
    expect(peer.getStats).toHaveBeenCalledTimes(2);
  });

  it('exports accessibility helpers for custom inspectors', () => {
    const snapshot = normalizeIosTree([
      {
        frame: { x: 0, y: 0, width: 100, height: 200 },
        type: 'Application',
        children: [
          {
            frame: { x: 10, y: 10, width: 50, height: 50 },
            type: 'Button',
            AXLabel: 'Continue',
            AXUniqueId: 'continue',
          },
        ],
      },
    ]);
    const element = axElementAtPoint(snapshot, 20, 20)!;
    expect(element.label).toBe('Continue');
    expect(axElementSelectorExpression(element, 'ios')).toContain('continue');
  });
  it('negotiates the same codecs, uses shared playback, and sends input and screenshot commands', async () => {
    const client = create();
    const video = document.createElement('video');
    const detach = client.attachVideo(video);
    const { socket, peer } = await handshake(client);
    expect(new URL(socket.url).searchParams.get('token')).toBe('secret');
    expect(peer.configuration.iceTransportPolicy).toBe('relay');
    expect(peer.transceivers[1].setCodecPreferences.mock.calls[0][0].map((c: any) => c.mimeType)).toEqual([
      'video/VP9',
      'video/H265',
      'video/H264',
      'video/VP8',
    ]);
    peer.connected();
    const stream = peer.track();
    expect(attachVideoStream).toHaveBeenCalledWith(video, stream, expect.any(Function));
    video.dispatchEvent(new Event('loadeddata'));
    expect(client.getState()).toMatchObject({
      connection: 'connected',
      videoReady: true,
      controlReady: true,
    });
    client.sendTouch('begin', 25, 50, 390, 844);
    client.sendTouch('end', 25, 50, 390, 844);
    expect(new DataView(peer.channel.send.mock.calls[0][0]).getInt32(10, true)).toBe(25);
    expect(new DataView(peer.channel.send.mock.calls[1][0]).getUint16(22, true)).toBe(0);
    client.sendText('hello');
    client.pressButton('home');
    expect(peer.channel.send).toHaveBeenCalledTimes(5);
    const result = client.screenshot();
    const request = socket.sent.at(-1)!;
    socket.message({ type: 'screenshotResult', id: request.id, base64: 'cG5n' });
    await expect(result).resolves.toEqual({ dataUri: 'data:image/png;base64,cG5n' });
    detach();
    expect(video.srcObject).toBeNull();
    client.dispose();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('supports an authenticated proxy socket on an HTTP origin without adding credentials or probing its URL', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const socket = new Socket('wss://t3/device?ticket=host-ticket');
    socket.open();
    const connect = vi.fn(() => socket as unknown as WebSocket);
    const client = create({ platform: 'android', transport: { connect }, autoReconnect: true });
    client.start();
    await flush();
    expect(socket.sent[0]?.type).toBe('requestRtcConfiguration');
    expect(socket.sent[0]?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    socket.message({ type: 'rtcConfiguration', rtcConfiguration: { iceServers: [] } });
    await flush();
    const peer = Peer.peers[0]!;
    peer.connected();
    expect(peer.transceivers.map((t) => t.direction)).toEqual(['recvonly', 'recvonly']);
    const pending = client.screenshot();
    const rejected = expect(pending).rejects.toThrow('disconnected');
    peer.fail();
    await rejected;
    expect(client.getState().connection).toBe('reconnecting');
    expect(socket.url).toBe('wss://t3/device?ticket=host-ticket');
    client.stop();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps initial transient ICE failures alive until the control channel opens', async () => {
    const client = create();
    const { peer } = await handshake(client);
    peer.connectionState = 'failed';
    peer.onconnectionstatechange?.();
    peer.iceConnectionState = 'failed';
    peer.oniceconnectionstatechange?.();
    expect(peer.close).not.toHaveBeenCalled();
    peer.connected();
    expect(client.getState().controlReady).toBe(true);
  });
  it.each(['opening', 'configuration'])('cancels a pending %s handshake when disposed', async (stage) => {
    const client = create();
    client.start();
    await flush();
    if (stage === 'configuration') {
      Socket.sockets[0]!.open();
      await flush();
    }
    client.dispose();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(Socket.sockets[0]!.close).toHaveBeenCalledOnce();
    expect(() => client.start()).toThrow('disposed');
  });
  it('closes a proxy socket whose asynchronous creation finishes after stop', async () => {
    let resolve!: (value: WebSocket) => void;
    const client = create({
      platform: 'ios',
      transport: {
        connect: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    client.start();
    client.stop();
    const socket = new Socket('wss://proxy');
    resolve(socket as unknown as WebSocket);
    await flush();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(client.getState().connection).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('attaches a late Duo renderer to the retained inner track', async () => {
    const client = create();
    const { peer, socket } = await handshake(client, { foldSupported: true });
    peer.connected();
    const inner = peer.track('duo-inner');
    const video = document.createElement('video');
    client.attachVideo(video, 'inner');
    expect(attachVideoStream).toHaveBeenCalledWith(video, expect.any(Stream), expect.any(Function));
    expect((video.srcObject as unknown as Stream).getTracks()).toEqual(inner.getTracks());
    expect(socket.sent.find((m) => m.type === 'offer')).toMatchObject({ displayStreams: true });
    expect(client.getState().duo).toBe(true);
  });
  it('ignores a late termination probe after the caller stops the client', async () => {
    let resolve!: (value: boolean) => void;
    const client = create({
      platform: 'ios',
      autoReconnect: true,
      transport: {
        connect: () => new Socket('wss://proxy') as unknown as WebSocket,
        isTerminated: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    const { peer } = await handshake(client);
    peer.connected();
    peer.fail();
    client.stop();
    resolve(true);
    await flush();
    expect(client.getState().connection).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels frame delivery on stop and releases the sink on dispose', async () => {
    const client = create();
    const present = vi.fn();
    const release = client.attachFrameSink({ present });
    const { peer } = await handshake(client);
    peer.connected();
    peer.track();
    const video = vi.mocked(attachVideoStream).mock.calls.at(-1)![0];
    Object.defineProperties(video, {
      readyState: { value: 2 },
      videoWidth: { value: 390 },
      videoHeight: { value: 844 },
    });
    video.dispatchEvent(new Event('loadeddata'));
    expect(present).toHaveBeenCalledWith(video, 390, 844, 'primary');
    client.stop();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
    release();
    expect(video.srcObject).toBeNull();
  });
  it('reconnects through a fresh proxy socket and restores input', async () => {
    const connect = vi.fn(() => new Socket('wss://proxy') as unknown as WebSocket);
    const client = create({ platform: 'android', autoReconnect: true, transport: { connect } });
    const { socket, peer } = await handshake(client);
    peer.connected();
    peer.fail();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const replacement = Socket.sockets.at(-1)!;
    expect(replacement).not.toBe(socket);
    replacement.open();
    await flush();
    replacement.message({ type: 'rtcConfiguration', rtcConfiguration: { iceServers: [] } });
    await flush();
    const nextPeer = Peer.peers.at(-1)!;
    nextPeer.connected();
    client.pressButton('back');
    expect(peer.channel.send).not.toHaveBeenCalled();
    expect(nextPeer.channel.send).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    client.dispose();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['camera', 'microphone'])('releases a late %s permission result after disposal', async (kind) => {
    let resolve!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((r) => {
          resolve = r;
        }),
    );
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia } });
    const client = create();
    const { socket, peer } = await handshake(client);
    peer.connected();
    socket.message({ type: kind === 'camera' ? 'cameraRequest' : 'microphoneRequest', active: true });
    await flush();
    expect(getUserMedia).toHaveBeenCalledOnce();
    client.dispose();
    const track = {
      kind: kind === 'camera' ? 'video' : 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    resolve(new Stream([track]) as unknown as MediaStream);
    await flush();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(
      peer.transceivers
        .filter((t) => t.direction === 'sendonly')
        .every((t) => t.sender.replaceTrack.mock.calls.length === 0),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Exercise the React adapter with the real core. Only browser media and the server are faked.
describe('RemoteControl compatibility', () => {
  let host: HTMLDivElement;
  let handle: ReturnType<typeof createRef<RemoteControlHandle>>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 200,
      width: 100,
      height: 200,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(200);
    host = document.createElement('div');
    document.body.appendChild(host);
    mountedRoot = createRoot(host);
    handle = createRef<RemoteControlHandle>();
  });
  const render = async (props: Partial<RemoteControlProps> = {}) => {
    await act(async () =>
      mountedRoot!.render(
        createElement(RemoteControl, { url: 'wss://host/ios_test', token: 'secret', ref: handle, ...props }),
      ),
    );
  };
  const connect = async () => {
    let connection!: Awaited<ReturnType<typeof handshake>>;
    await act(async () => {
      connection = await handshake();
      connection.peer.connected();
      connection.peer.track();
      host.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
      host.querySelector('video')!.dispatchEvent(new Event('loadeddata'));
    });
    return connection;
  };

  it('clears rendered inspector boxes and callbacks when the connection drops', async () => {
    const onAxSnapshotChange = vi.fn();
    await render({ inspectMode: true, onAxSnapshotChange });
    const { socket, peer } = await connect();
    await act(async () => {
      respondWithTree(socket);
      await flush();
      vi.runAllTicks();
    });
    expect(host.querySelector('[data-ax-id="continue"]')).not.toBeNull();
    await act(async () => {
      handle.current!.setInspectHighlight(handle.current!.getAxSnapshot()!.elements[0]);
      handle.current!.setInspectSelection(handle.current!.getAxSnapshot()!.elements[0]);
    });
    expect(host.querySelector('[data-selected="true"]')).not.toBeNull();
    await act(async () => {
      peer.fail();
      await flush();
      vi.runAllTicks();
    });
    expect(host.querySelector('[data-ax-id]')).toBeNull();
    expect(handle.current!.getAxSnapshot()).toBeNull();
    expect(onAxSnapshotChange).toHaveBeenLastCalledWith(null);
    expect(host.querySelector('.rc-retry-button')).not.toBeNull();
  });

  it('keeps the session ID across credential changes', async () => {
    await render({ openUrl: 'myapp://first' });
    const first = await connect();
    const sessionId = first.socket.sent.find(
      (message) => message.type === 'requestRtcConfiguration',
    )!.sessionId;
    await render({ token: 'new-token', openUrl: 'myapp://second' });
    const second = await connect();
    expect(second.socket.sent.find((message) => message.type === 'requestRtcConfiguration')!.sessionId).toBe(
      sessionId,
    );
  });

  it('uses updated URL and accessibility polling options on manual retry', async () => {
    await render({ token: 'new-token', openUrl: 'myapp://second' });
    const first = await connect();
    const sessionId = first.socket.sent.find(
      (message) => message.type === 'requestRtcConfiguration',
    )!.sessionId;
    await render({ token: 'new-token', openUrl: 'myapp://third', inspectMode: true, axPollIntervalMs: 500 });
    expect(Socket.sockets).toHaveLength(1);
    await act(async () => handle.current!.reconnect());
    const third = await connect();
    expect(third.socket.sent.find((message) => message.type === 'openUrl')).toMatchObject({
      url: 'myapp://third',
      sessionId,
    });
    await act(async () => {
      respondWithTree(third.socket);
      await flush();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(third.socket.sent.filter((message) => message.type === 'elementTree')).toHaveLength(2);
  });

  it('preserves playback measurements and the connection across prop and callback changes', async () => {
    const onPlaybackStats = vi.fn();
    await render({ onPlaybackStats });
    const { peer } = await connect();
    await act(async () => {
      peer.connectionState = 'connected';
      peer.dispatchEvent(new Event('connectionstatechange'));
    });
    const next = vi.fn();
    await render({
      onPlaybackStats: next,
      jitterBufferTargetMs: 0,
      microphoneEnabled: true,
      inspectMode: 'hover-only',
      autoReconnect: true,
    });
    expect(Peer.peers).toHaveLength(1);
    expect(peer.getStats).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(next.mock.lastCall![0]).toMatchObject({
      requestedTargetMs: 0,
      video: [{ fps: 50, intervalMs: 2000 }],
    });
    expect(onPlaybackStats).toHaveBeenCalledTimes(1);
  });

  it.each(['ios', 'android'])(
    'retains %s keyboard shortcuts, paste, touch, and wheel input',
    async (platform) => {
      vi.stubGlobal('navigator', { onLine: true, clipboard: { readText: vi.fn(async () => 'hello') } });
      await render({ url: `wss://host/${platform}_test` });
      const { peer } = await connect();
      const video = host.querySelector('video')!;
      const container = host.querySelector('.rc-container')!;
      await act(async () => {
        video.focus();
        video.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', ctrlKey: true, bubbles: true }),
        );
        video.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true }),
        );
        await flush();
      });
      let messages = peer.channel.send.mock.calls.map(([buffer]) => new DataView(buffer));
      expect(messages.map((message) => message.getUint8(0))).toEqual([
        CONTROL_MSG_TYPE.INJECT_KEYCODE,
        CONTROL_MSG_TYPE.INJECT_KEYCODE,
        CONTROL_MSG_TYPE.SET_CLIPBOARD,
      ]);
      expect(new TextDecoder().decode(peer.channel.send.mock.calls[2][0].slice(14))).toBe('hello');
      peer.channel.send.mockClear();
      await act(async () => {
        container.dispatchEvent(
          new MouseEvent('mousedown', { clientX: 25, clientY: 50, bubbles: true, buttons: 1 }),
        );
        container.dispatchEvent(new MouseEvent('mouseup', { clientX: 25, clientY: 50, bubbles: true }));
      });
      messages = peer.channel.send.mock.calls.map(([buffer]) => new DataView(buffer));
      expect(messages.map((message) => message.getUint8(1))).toEqual([0, 1]);
      expect(messages[0].getInt32(10, true)).toBe(25);
      expect(messages[0].getInt32(14, true)).toBe(50);
      peer.channel.send.mockClear();
      await act(async () => {
        container.dispatchEvent(
          new WheelEvent('wheel', { clientX: 50, clientY: 100, deltaY: 20, bubbles: true, cancelable: true }),
        );
        await vi.advanceTimersByTimeAsync(300);
      });
      messages = peer.channel.send.mock.calls.map(([buffer]) => new DataView(buffer));
      expect(messages.every((message) => message.getUint8(0) === CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT)).toBe(
        true,
      );
      expect(messages.map((message) => message.getUint8(1))).toEqual([0, 2, 1]);
    },
  );

  it.each(['ios', 'android'])('retains %s Alt-drag pinch gestures', async (platform) => {
    await render({ url: `wss://host/${platform}_test` });
    const { peer } = await connect();
    const container = host.querySelector('.rc-container')!;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', altKey: true }));
      container.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 25, clientY: 50, buttons: 1, altKey: true, bubbles: true }),
      );
      container.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 20, clientY: 40, buttons: 1, altKey: true, bubbles: true }),
      );
      container.dispatchEvent(
        new MouseEvent('mouseup', { clientX: 20, clientY: 40, altKey: true, bubbles: true }),
      );
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', code: 'AltLeft' }));
    });
    const messages = peer.channel.send.mock.calls.map(([buffer]) => new DataView(buffer));
    const touchType =
      platform === 'ios' ?
        CONTROL_MSG_TYPE.INJECT_TWO_FINGER_TOUCH_EVENT
      : CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT;
    const touches = messages.filter((message) => message.getUint8(0) === touchType);
    expect(touches.map((message) => message.getUint8(1))).toEqual(
      platform === 'ios' ? [0, 2, 1] : [0, 0, 2, 2, 1, 1],
    );
  });

  it('retains camera demand and manual microphone forwarding without recapturing on unrelated prop changes', async () => {
    const mic = { kind: 'audio', label: 'Microphone', stop: vi.fn() };
    const camera = {
      kind: 'video',
      label: 'Camera',
      readyState: 'live',
      stop: vi.fn(),
      getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
    };
    const getUserMedia = vi.fn(
      async (constraints: MediaStreamConstraints) =>
        new Stream([constraints.audio ? mic : camera] as MediaStreamTrack[]),
    );
    vi.stubGlobal('navigator', { onLine: true, mediaDevices: { getUserMedia } });
    const onMicrophoneStateChange = vi.fn();
    const onCameraDemandChange = vi.fn();
    await render({ onMicrophoneStateChange, onCameraDemandChange });
    const { socket, peer } = await connect();
    await render({ microphoneEnabled: true, onMicrophoneStateChange, onCameraDemandChange });
    expect(onMicrophoneStateChange).toHaveBeenLastCalledWith({ active: true, label: 'Microphone' });
    await act(async () => {
      socket.message({ type: 'cameraRequest', active: true, facingMode: 'user' });
      await flush();
    });
    expect(onCameraDemandChange).toHaveBeenLastCalledWith(
      true,
      true,
      expect.objectContaining({ width: 1280, height: 720 }),
    );
    const cameraSender = peer.transceivers.find(
      (t) => t.direction === 'sendonly' && t.receiver.track.kind === 'video',
    ).sender;
    cameraSender.getStats = vi.fn(async () => new Map());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(cameraSender.getStats).not.toHaveBeenCalled();
    const onCameraStats = vi.fn();
    await render({
      microphoneEnabled: true,
      inspectMode: 'hover-only',
      jitterBufferTargetMs: 20,
      onMicrophoneStateChange,
      onCameraDemandChange,
      onCameraStats,
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(cameraSender.getStats).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(
      peer.transceivers
        .filter((t) => t.direction === 'sendonly')
        .map((t) => t.sender.replaceTrack.mock.lastCall[0]),
    ).toEqual([camera, mic]);
    await act(async () => {
      peer.fail();
      await flush();
    });
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(onMicrophoneStateChange).toHaveBeenLastCalledWith({ active: false });
  });

  it('keeps screenshot, app termination, URL, and keyboard commands available through the ref', async () => {
    await render();
    const { socket, peer } = await connect();
    handle.current!.openUrl('myapp://home');
    expect(socket.sent.at(-1)).toMatchObject({ type: 'openUrl', url: 'myapp://home' });
    handle.current!.sendKeyEvent({ type: 'keydown', code: 'Enter' });
    expect(peer.channel.send).toHaveBeenCalledOnce();
    const screenshot = handle.current!.screenshot();
    socket.message({ type: 'screenshotResult', id: socket.sent.at(-1)!.id, base64: 'cG5n' });
    await expect(screenshot).resolves.toEqual({ dataUri: 'data:image/png;base64,cG5n' });
    const terminate = handle.current!.terminateApp('com.example.app');
    socket.message({ type: 'terminateAppResult', id: socket.sent.at(-1)!.id });
    await expect(terminate).resolves.toBeUndefined();
  });
});
