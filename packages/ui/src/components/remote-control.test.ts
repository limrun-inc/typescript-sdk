// Assertions parse the result and read decoded parameter values, so they
// don't depend on whether a space serializes as `+` or `%20`.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RemoteControl, withAuthenticationToken, type RemoteControlProps } from './remote-control';

describe('withAuthenticationToken', () => {
  test('adds the token alongside query parameters already on the endpoint', () => {
    const result = new URL(
      withAuthenticationToken('wss://example.com/socket?transport=webrtc', 'instance-token'),
    );

    expect(result.searchParams.get('transport')).toBe('webrtc');
    expect(result.searchParams.get('token')).toBe('instance-token');
  });

  test('keeps a token containing URL syntax as a single decoded value', () => {
    const token = 'instance token&scope=preview';
    const result = new URL(withAuthenticationToken('wss://example.com/socket?transport=webrtc', token));

    expect(result.searchParams.get('token')).toBe(token);
    expect(result.searchParams.get('transport')).toBe('webrtc');
    expect(result.searchParams.get('scope')).toBeNull();
  });

  test('replaces an existing token instead of duplicating it', () => {
    const result = new URL(withAuthenticationToken('wss://example.com/socket?token=stale', 'fresh-token'));

    expect(result.searchParams.getAll('token')).toEqual(['fresh-token']);
  });
});

describe('runtime device information', () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    static sockets: Socket[] = [];
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose = null;
    onerror = null;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      Socket.sockets.push(this);
    }
    receive(message: object) {
      const event = new MessageEvent('message', { data: JSON.stringify(message) });
      this.dispatchEvent(event);
      this.onmessage?.(event);
    }
  }
  class Peer {
    static peers: Peer[] = [];
    ontrack: ((event: { track: { kind: string }; streams: object[] }) => void) | null = null;
    constructor() {
      Peer.peers.push(this);
    }
    addTransceiver() {
      return { sender: { replaceTrack: vi.fn() }, setCodecPreferences: vi.fn() };
    }
    createDataChannel() {
      return { close: vi.fn() };
    }
    createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }));
    setLocalDescription = vi.fn(async () => undefined);
    close = vi.fn();
  }
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    Socket.sockets = [];
    Peer.peers = [];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('RTCPeerConnection', Peer);
    vi.stubGlobal('RTCRtpReceiver', {});
    vi.stubGlobal('RTCRtpSender', {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const props = {
    url: 'wss://example.test/ios_test/signaling',
    token: 'token',
    assets: { ios: { frame: 'phone.png' } },
  };
  async function connect(extra: Partial<RemoteControlProps> = {}, foldSupported = false) {
    await act(async () => root.render(createElement(RemoteControl, { ...props, ...extra })));
    const socket = Socket.sockets.at(-1)!;
    await act(async () => socket.onopen?.());
    await act(async () => socket.receive({ type: 'rtcConfiguration', rtcConfiguration: {}, foldSupported }));
    const request = socket.send.mock.calls
      .map(([text]) => JSON.parse(text))
      .find((m) => m.type === 'deviceInfo');
    return { socket, request };
  }
  test.each([
    ['iPhone 17 Pro', true],
    ['iPad Pro (13-inch) (M4)', false],
    ['Apple Watch Series 11', false],
  ])('detects %s and selects its frame on the existing socket', async (model, framed) => {
    const onDeviceInfoChange = vi.fn();
    const { socket, request } = await connect({ onDeviceInfoChange });
    expect(Socket.sockets).toHaveLength(1);
    expect(request).toBeDefined();
    await act(async () =>
      socket.receive({ type: 'deviceInfoResult', id: request.id, model, name: 'Simulator' }),
    );
    expect(onDeviceInfoChange).toHaveBeenLastCalledWith({ model, name: 'Simulator', foldSupported: false });
    expect(!!container.querySelector('.rc-phone-frame')).toBe(framed);
    await act(async () => vi.advanceTimersByTime(3000));
    expect(socket.send.mock.calls.filter(([text]) => JSON.parse(text).type === 'deviceInfo')).toHaveLength(1);
  });
  test('plays video before device information arrives, even after metadata retries expire', async () => {
    const onDeviceInfoChange = vi.fn();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { socket } = await connect({ onDeviceInfoChange });
    expect(socket.send.mock.calls.map(([text]) => JSON.parse(text).type)).toContain('offer');
    expect(onDeviceInfoChange).toHaveBeenLastCalledWith(null);

    const stream = { id: 'video' };
    await act(async () => Peer.peers.at(-1)!.ontrack?.({ track: { kind: 'video' }, streams: [stream] }));
    expect(container.querySelector('video')!.srcObject).toBe(stream);
    expect(play).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTime(9000));
    expect(socket.send.mock.calls.filter(([text]) => JSON.parse(text).type === 'deviceInfo')).toHaveLength(3);
    expect(container.querySelector('video')!.srcObject).toBe(stream);
    expect(onDeviceInfoChange).toHaveBeenLastCalledWith(null);
    expect(Peer.peers.at(-1)!.close).not.toHaveBeenCalled();
  });
  test('reports Duo capabilities without forcing its model through props', async () => {
    const onDeviceInfoChange = vi.fn();
    const { socket, request } = await connect({ onDeviceInfoChange }, true);
    await act(async () => socket.receive({ type: 'deviceInfoResult', id: request.id, model: 'iPhone Duo' }));
    expect(onDeviceInfoChange).toHaveBeenLastCalledWith({ model: 'iPhone Duo', foldSupported: true });
    expect(container.querySelectorAll('video')).toHaveLength(2);
  });
  test('preserves an explicit frameless preference', async () => {
    const { socket, request } = await connect({ showFrame: false });
    await act(async () => socket.receive({ type: 'deviceInfoResult', id: request.id, model: 'iPhone 17' }));
    expect(container.querySelector('.rc-phone-frame')).toBeNull();
  });
  test('retries boot-time failures without opening another socket', async () => {
    const { socket, request } = await connect();
    await act(async () => socket.receive({ type: 'deviceInfoError', id: request.id, error: 'Not booted' }));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(socket.send.mock.calls.filter(([text]) => JSON.parse(text).type === 'deviceInfo')).toHaveLength(2);
    expect(Socket.sockets).toHaveLength(1);
  });
  test('resets information on a changed instance and ignores its old socket', async () => {
    const onDeviceInfoChange = vi.fn();
    const first = await connect({ onDeviceInfoChange });
    await act(async () =>
      first.socket.receive({ type: 'deviceInfoResult', id: first.request.id, model: 'iPhone 17' }),
    );
    const second = await connect({ onDeviceInfoChange, url: 'wss://example.test/ios_second/signaling' });
    expect(onDeviceInfoChange).toHaveBeenLastCalledWith(null);
    await act(async () =>
      first.socket.receive({ type: 'deviceInfoResult', id: first.request.id, model: 'iPhone Duo' }),
    );
    expect(onDeviceInfoChange).toHaveBeenLastCalledWith(null);
    await act(async () =>
      second.socket.receive({ type: 'deviceInfoResult', id: second.request.id, model: 'iPad Pro' }),
    );
    expect(onDeviceInfoChange).toHaveBeenLastCalledWith({ model: 'iPad Pro', foldSupported: false });
  });
  test('does not send the iOS metadata request to Android runtimes', async () => {
    const { request } = await connect({ url: 'wss://example.test/android_test/signaling' });
    expect(request).toBeUndefined();
  });
});
