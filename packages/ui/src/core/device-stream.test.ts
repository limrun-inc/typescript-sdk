import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceStream, type DeviceStream } from './device-stream';
import { attachVideoStream } from './video-playback';

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
      receiver: { track: { kind, readyState: 'live' }, jitterBufferTarget: 0 },
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
async function handshake(client: DeviceStream, config: object = {}) {
  client.start();
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
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.dispose());
  await flush();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('headless device stream', () => {
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
    socket.drop();
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
    const { socket, peer } = await handshake(client);
    peer.connected();
    socket.drop();
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
    socket.drop();
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
