import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RemoteControl } from './remote-control';

const offers: Record<string, unknown>[] = [];
const peers: Peer[] = [];
class Socket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    super();
    queueMicrotask(() => this.onopen?.());
  }
  send(raw: string) {
    const message = JSON.parse(raw);
    if (message.type === 'requestRtcConfiguration') {
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'rtcConfiguration', rtcConfiguration: {} }),
          }),
        ),
      );
    } else if (message.type === 'offer') {
      offers.push(message);
    }
  }
  close() {
    this.readyState = 3;
  }
}
class Peer {
  channels = new Map<
    string,
    { onmessage: ((event: MessageEvent) => void) | null; close: ReturnType<typeof vi.fn> }
  >();
  close = vi.fn();
  constructor() {
    peers.push(this);
  }
  addTransceiver() {
    return { sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) } };
  }
  createDataChannel(label: string) {
    const channel = { onmessage: null, close: vi.fn() };
    this.channels.set(label, channel);
    return channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' };
  }
  async setLocalDescription() {}
}
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (callback?: (message: Record<string, unknown>) => void, android = false) => {
  await act(async () =>
    root.render(
      <RemoteControl
        url={`wss://example.com/${android ? 'android' : 'ios'}_test`}
        token="test"
        onLatencyTrace={callback}
      />,
    ),
  );
};
beforeEach(() => {
  offers.length = 0;
  peers.length = 0;
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
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('ordinary connections create only the control channel and omit the trace offer', async () => {
  await render();
  expect(offers).toHaveLength(1);
  expect(offers[0]).not.toHaveProperty('latencyTraceVersion');
  expect([...peers[0]!.channels.keys()]).toEqual(['control']);
});

test('callback replacement keeps the connection, while adding or removing it reconnects', async () => {
  await render();
  const first = vi.fn(),
    second = vi.fn();
  await render(first);
  expect(peers).toHaveLength(2);
  expect(offers.at(-1)).toHaveProperty('latencyTraceVersion', 1);
  const channel = peers[1]!.channels.get('latency-trace-v1')!;
  const event = new MessageEvent('message', { data: '{"type":"latencyTrace","records":[]}' });
  channel.onmessage?.(event);
  expect(first).toHaveBeenCalledOnce();
  await render(second);
  expect(peers).toHaveLength(2);
  channel.onmessage?.(event);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  const queued = channel.onmessage;
  await render();
  expect(peers).toHaveLength(3);
  expect(channel.close).toHaveBeenCalledOnce();
  queued?.(event);
  expect(second).toHaveBeenCalledOnce();
  expect(offers.at(-1)).not.toHaveProperty('latencyTraceVersion');
});

test('callback exceptions do not interrupt subsequent messages', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const callback = vi.fn(() => {
    throw new Error('customer callback');
  });
  await render(callback);
  const channel = peers[0]!.channels.get('latency-trace-v1')!;
  const event = new MessageEvent('message', { data: '{"type":"latencyTrace"}' });
  channel.onmessage?.(event);
  channel.onmessage?.(event);
  expect(callback).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledTimes(2);
});

test('Android connections do not negotiate the iOS trace protocol', async () => {
  await render(vi.fn(), true);
  expect(offers).toHaveLength(1);
  expect(offers[0]).not.toHaveProperty('latencyTraceVersion');
  expect([...peers[0]!.channels.keys()]).toEqual(['control']);
});
