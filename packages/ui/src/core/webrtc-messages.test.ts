import { expect, test, vi } from 'vitest';
import { AMOTION_EVENT } from './constants';
import { createLatencyTrace } from './latency-trace';
import { createTouchControlMessage } from './webrtc-messages';

test('encodes a two-finger gesture as per-pointer transitions, with and without tracing', () => {
  const gesture = [
    [AMOTION_EVENT.ACTION_DOWN, -2],
    [AMOTION_EVENT.ACTION_POINTER_DOWN, -3],
    [AMOTION_EVENT.ACTION_MOVE, -2],
    [AMOTION_EVENT.ACTION_MOVE, -3],
    [AMOTION_EVENT.ACTION_POINTER_UP, -3],
    [AMOTION_EVENT.ACTION_UP, -2],
  ];
  const channel = { close: vi.fn() };
  const peer = { createDataChannel: () => channel } as unknown as RTCPeerConnection;
  for (const tracing of [false, true]) {
    const trace = createLatencyTrace(peer, () => undefined);
    if (tracing) trace.accept(1);
    const actions: number[] = [];
    gesture.forEach(([action, pointerId], index) => {
      const input = createTouchControlMessage(action!, pointerId!, 720, 1616, 100, 200);
      const sent = trace.wrap(input);
      expect(sent.byteLength).toBe(tracing ? 38 : 32);
      const offset = tracing ? 6 : 0;
      const view = new DataView(sent);
      actions.push(view.getUint8(offset + 1));
      expect(view.getBigInt64(offset + 2, true)).toBe(BigInt(pointerId!));
      if (tracing) expect(view.getUint32(2, true)).toBe(index + 1);
    });
    expect(actions).toEqual([0, 0, 2, 2, 1, 1]);
  }
});
