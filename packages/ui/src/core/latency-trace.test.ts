import { describe, expect, test, vi } from 'vitest';
import { createLatencyTrace } from './latency-trace';
import { createInjectKeycodeMessage, createTouchControlMessage } from './webrtc-messages';

function setup() {
  const channel = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as (() => void) | null,
    close: vi.fn(),
  };
  const peer = { createDataChannel: vi.fn(() => channel) };
  const callback = vi.fn();
  const trace = createLatencyTrace(peer as unknown as RTCPeerConnection, callback);
  return { channel, peer, callback, trace };
}

const touch = () => createTouchControlMessage(0, -1, 900, 1962, 124, 432);

describe('latency tracing', () => {
  test('keeps inputs unchanged until the server accepts this protocol', () => {
    const { trace, peer } = setup();
    expect(peer.createDataChannel).toHaveBeenCalledWith('latency-trace-v1', {
      ordered: true,
      negotiated: true,
      id: 2,
    });
    const input = touch();
    expect(trace.wrap(input)).toBe(input);
    for (const version of [undefined, null, 0, 2, '1']) {
      trace.accept(version);
      expect(trace.wrap(input)).toBe(input);
    }
  });

  test('preserves touch payloads and gives each input a connection-local sequence', () => {
    const { trace } = setup();
    trace.accept(1);
    const input = touch();
    for (let seq = 1; seq <= 3; seq++) {
      const envelope = trace.wrap(input);
      expect(envelope.byteLength).toBe(38);
      expect([...new Uint8Array(envelope, 0, 2)]).toEqual([240, 1]);
      expect(new DataView(envelope).getUint32(2, true)).toBe(seq);
      expect(new Uint8Array(envelope, 6)).toEqual(new Uint8Array(input));
    }
    const key = createInjectKeycodeMessage(0, 3);
    expect(trace.wrap(key)).toBe(key);
    const next = setup().trace;
    next.accept(1);
    expect(new DataView(next.wrap(input)).getUint32(2, true)).toBe(1);
  });

  test('delivers every parsed message and ignores malformed data', () => {
    const { trace, channel, callback } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const messages = [
        { type: 'latencyTrace', sessionId: 'peer', records: [{ stage: 'encoded', frameSeq: 1 }] },
        { type: 'clockPong', id: 1, receivedMs: 123, sentMs: 124 },
        { type: 'flushed' },
      ];
      for (const message of messages)
        channel.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
      channel.onmessage?.(new MessageEvent('message', { data: 'broken' }));
      channel.onmessage?.(new MessageEvent('message', { data: 'null' }));
      expect(callback.mock.calls.map(([message]) => message)).toEqual(messages);
      expect(warn).toHaveBeenCalledOnce();
      const queued = channel.onmessage;
      trace.close();
      queued?.(new MessageEvent('message', { data: '{"type":"late"}' }));
      expect(callback).toHaveBeenCalledTimes(3);
      expect(channel.close).toHaveBeenCalledOnce();
      trace.accept(1);
      const input = touch();
      expect(trace.wrap(input)).toBe(input);
    } finally {
      warn.mockRestore();
    }
  });

  test('falls back to ordinary touch messages if the telemetry channel closes', () => {
    const { trace, channel } = setup();
    trace.accept(1);
    channel.onclose?.();
    trace.accept(1);
    const input = touch();
    expect(trace.wrap(input)).toBe(input);
  });
});
