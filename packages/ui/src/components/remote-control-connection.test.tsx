import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteControl } from './remote-control';

class SignalingSocket extends EventTarget {
  static OPEN = 1;
  static instances: SignalingSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  close = vi.fn();
  constructor() {
    super();
    SignalingSocket.instances.push(this);
    Promise.resolve().then(() => this.onopen?.());
  }
  send(message: string) {
    if (JSON.parse(message).type === 'requestRtcConfiguration') {
      Promise.resolve().then(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'rtcConfiguration', rtcConfiguration: { iceServers: [] } }),
          }),
        ),
      );
    }
  }
}

class PeerConnection {
  static instances: PeerConnection[] = [];
  connectionState = 'new';
  iceConnectionState = 'new';
  iceGatheringState = 'gathering';
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  channel = { onopen: null as (() => void) | null, close: vi.fn() };
  close = vi.fn();
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: '' });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  addTransceiver = vi.fn().mockReturnValue({ sender: {}, setCodecPreferences: vi.fn() });
  createDataChannel = vi.fn(() => this.channel);
  constructor() {
    PeerConnection.instances.push(this);
  }
}

let root: Root;
let host: HTMLDivElement;
const fetchProbe = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', SignalingSocket);
  vi.stubGlobal('RTCPeerConnection', PeerConnection);
  vi.stubGlobal('RTCRtpReceiver', {});
  vi.stubGlobal('RTCRtpSender', {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('fetch', fetchProbe.mockReset().mockResolvedValue({ status: 200 }));
  SignalingSocket.instances = [];
  PeerConnection.instances = [];
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(autoReconnect = false) {
  await act(async () => {
    root.render(
      <RemoteControl
        url="wss://example.com/android.limrun.com/v1/instances/android_test/endpointWebSocket"
        token="test-token"
        autoReconnect={autoReconnect}
      />,
    );
  });
  expect(PeerConnection.instances).toHaveLength(1);
  return PeerConnection.instances[0]!;
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

it.each(['connection', 'ice', 'disconnected'])(
  'preserves startup after a transient %s failure and cancels the deadline when control opens',
  async (event) => {
    const peer = await mount(true);
    await act(async () => {
      if (event === 'connection') {
        peer.connectionState = 'failed';
        peer.onconnectionstatechange?.();
      } else {
        peer.iceConnectionState = event === 'ice' ? 'failed' : 'disconnected';
        peer.oniceconnectionstatechange?.();
      }
    });
    await advance(14_999);
    expect(peer.close).not.toHaveBeenCalled();
    expect(SignalingSocket.instances[0]!.close).not.toHaveBeenCalled();
    expect(fetchProbe).not.toHaveBeenCalled();
    await act(async () => {
      peer.connectionState = 'connecting';
      peer.onconnectionstatechange?.();
      peer.iceConnectionState = 'connected';
      peer.oniceconnectionstatechange?.();
      peer.connectionState = 'connected';
      peer.onconnectionstatechange?.();
      peer.channel.onopen?.();
    });
    await advance(15_000);
    expect(peer.close).not.toHaveBeenCalled();
    expect(PeerConnection.instances).toHaveLength(1);
  },
);
it('closes a stalled attempt at the deadline and exhausts the existing retry budget', async () => {
  const peer = await mount();
  await advance(14_999);
  expect(peer.close).not.toHaveBeenCalled();
  await advance(1);
  expect(peer.close).toHaveBeenCalledOnce();
  expect(fetchProbe).toHaveBeenCalledOnce();
  await advance(120_000);
  expect(host.textContent).toContain('Retry');
  const attempts = PeerConnection.instances.length;
  await advance(120_000);
  expect(PeerConnection.instances).toHaveLength(attempts);
  expect(attempts).toBe(3);
});
it.each([false, true])(
  'preserves established-session failure behavior with autoReconnect=%s',
  async (autoReconnect) => {
    const peer = await mount(autoReconnect);
    await act(async () => peer.channel.onopen?.());
    await act(async () => {
      peer.connectionState = 'failed';
      peer.onconnectionstatechange?.();
    });
    expect(peer.close).toHaveBeenCalledOnce();
    expect(fetchProbe).toHaveBeenCalledOnce();
    await advance(1_000);
    expect(PeerConnection.instances).toHaveLength(autoReconnect ? 2 : 1);
    if (!autoReconnect) expect(host.textContent).toContain('Retry');
  },
);
it('still reports termination and stops retries when the deadline probe returns 404', async () => {
  fetchProbe.mockResolvedValue({ status: 404 });
  await mount();
  await advance(15_000);
  expect(host.textContent).toContain('Instance terminated');
  await advance(30_000);
  expect(PeerConnection.instances).toHaveLength(1);
});
