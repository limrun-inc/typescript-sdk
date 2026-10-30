import { describe, expect, test, vi } from 'vitest';
import { createLatencyTrace } from './latency-trace';

function connection() {
  const channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    close: vi.fn(),
  };
  const peer = { createDataChannel: vi.fn(() => channel) };
  const onMessage = vi.fn();
  const trace = createLatencyTrace(peer as unknown as RTCPeerConnection, onMessage);
  return { channel, peer, onMessage, trace };
}

function touch() {
  const data = new ArrayBuffer(32);
  const view = new DataView(data);
  view.setUint8(0, 2);
  view.setUint8(1, 0);
  view.setBigInt64(2, -2n, true);
  view.setUint32(10, 100, true);
  view.setUint32(14, 200, true);
  return data;
}

describe('latency trace v1', () => {
  test('keeps ordinary input until the server accepts the shared protocol', () => {
    const { peer, trace } = connection();
    expect(peer.createDataChannel).toHaveBeenCalledWith('latency-trace-v1', {
      ordered: true,
      negotiated: true,
      id: 2,
    });
    const data = touch();
    for (const version of [undefined, 0, 2, '1']) {
      trace.accept(version);
      expect(trace.wrap(data)).toBe(data);
    }
    trace.accept(1);
    const first = trace.wrap(data);
    expect(first.byteLength).toBe(38);
    expect([...new Uint8Array(first, 0, 6)]).toEqual([240, 1, 1, 0, 0, 0]);
    expect(new Uint8Array(first, 6)).toEqual(new Uint8Array(data));
    expect(new DataView(trace.wrap(data)).getUint32(2, true)).toBe(2);
  });

  test('does not wrap keys, text or malformed touch payloads', () => {
    const { trace } = connection();
    trace.accept(1);
    for (const data of [new ArrayBuffer(32), new ArrayBuffer(8), new ArrayBuffer(0)]) {
      expect(trace.wrap(data)).toBe(data);
    }
  });

  test('preserves cancel and Android multi-touch transitions outside the v1 envelope', () => {
    const { trace } = connection();
    trace.accept(1);
    for (const action of [3, 5, 6]) {
      const data = touch();
      new DataView(data).setUint8(1, action);
      expect(trace.wrap(data)).toBe(data);
    }
    expect(new DataView(trace.wrap(touch())).getUint32(2, true)).toBe(1);
  });

  test('forwards server batches unchanged and detaches on connection cleanup', () => {
    const { trace, channel, onMessage } = connection();
    const batch = {
      type: 'latencyTrace',
      version: 1,
      sessionId: 'android-session',
      batchSeq: 1,
      droppedRecords: 0,
      records: [{ stage: 'hidCompleted', inputSeq: 1, timeMs: 123.25 }],
    };
    const receive = channel.onmessage!;
    receive({ data: JSON.stringify(batch) });
    expect(onMessage).toHaveBeenCalledWith(batch);
    trace.close();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(channel.onmessage).toBeNull();
    receive({ data: JSON.stringify(batch) });
    expect(onMessage).toHaveBeenCalledOnce();
    trace.accept(1);
    const data = touch();
    expect(trace.wrap(data)).toBe(data);
  });

  test('falls back to ordinary input if the trace channel closes', () => {
    const { trace, channel } = connection();
    trace.accept(1);
    channel.onclose!();
    const data = touch();
    expect(trace.wrap(data)).toBe(data);
  });
});
