import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyJitterBufferTarget } from './jitter-buffer';

function receiverWithTarget(initial: number | null = null) {
  let target = initial;
  const setTarget = vi.fn((value: number | null) => {
    target = value;
  });
  const receiver = Object.defineProperty({}, 'jitterBufferTarget', {
    get: () => target,
    set: setTarget,
  }) as RTCRtpReceiver;
  return { receiver, setTarget, target: () => target };
}

afterEach(() => vi.restoreAllMocks());

describe('applyJitterBufferTarget', () => {
  test('leaves automatic buffering untouched when the prop is omitted', () => {
    const { receiver, setTarget } = receiverWithTarget();
    applyJitterBufferTarget(receiver, undefined);
    expect(setTarget).not.toHaveBeenCalled();
  });

  test('accepts zero and both range boundaries without treating zero as a reset', () => {
    const { receiver, target } = receiverWithTarget();
    for (const value of [0, 50, 4000]) {
      applyJitterBufferTarget(receiver, value);
      expect(target()).toBe(value);
    }
  });

  test.each([undefined, null])('restores automatic buffering for %s', (value) => {
    const { receiver, target } = receiverWithTarget(50);
    applyJitterBufferTarget(receiver, value);
    expect(target()).toBeNull();
  });

  test.each([-1, 4001, NaN, Infinity, -Infinity])('ignores an invalid target %s', (value) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { receiver, setTarget, target } = receiverWithTarget(50);
    applyJitterBufferTarget(receiver, value);
    expect(setTarget).not.toHaveBeenCalled();
    expect(target()).toBe(50);
    expect(warning).toHaveBeenCalledOnce();
  });

  test('does not invent a property on an unsupported receiver', () => {
    const receiver = Object.freeze({}) as RTCRtpReceiver;
    expect(() => applyJitterBufferTarget(receiver, 50)).not.toThrow();
    expect('jitterBufferTarget' in receiver).toBe(false);
  });

  test('keeps playback setup running when a browser rejects the setting', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { receiver, setTarget } = receiverWithTarget();
    setTarget.mockImplementation(() => {
      throw new DOMException('Receiver unavailable', 'InvalidStateError');
    });
    expect(() => applyJitterBufferTarget(receiver, 50)).not.toThrow();
    expect(warning).toHaveBeenCalledOnce();
  });
});
