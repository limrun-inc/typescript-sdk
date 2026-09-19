import { describe, expect, it, vi } from 'vitest';
import {
  createDisplayTouchMessage,
  duoPointerMode,
  DuoButtonSender,
  HingeSender,
  panelTouch,
  validHingeAngle,
} from './duo';

describe('native Duo input', () => {
  it('rejects non-finite and out-of-range hinge values', () => {
    for (const angle of [NaN, Infinity, -1, 181]) expect(validHingeAngle(angle)).toBe(false);
    for (const angle of [0, 45.5, 90, 180]) expect(validHingeAngle(angle)).toBe(true);
  });
  it('encodes panel identity and top-left coordinates without video rotation', () => {
    const point = panelTouch(0.3, 0.6);
    const data = new DataView(createDisplayTouchMessage(0, 3, point.x, point.y));
    expect(data.byteLength).toBe(12);
    expect(data.getUint8(0)).toBe(19);
    expect(data.getUint8(2)).toBe(3);
    expect(data.getFloat32(4, true)).toBeCloseTo(0.3);
    expect(data.getFloat32(8, true)).toBeCloseTo(0.4);
    expect(() => createDisplayTouchMessage(0, 3, NaN, 0)).toThrow();
  });
  it('sends the final slider angle while coalescing intermediate positions', async () => {
    let finish!: () => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const sender = new HingeSender(send, vi.fn());
    sender.set(10);
    sender.set(20);
    sender.set(90);
    sender.set(180);
    expect(send.mock.calls).toEqual([[10]]);
    finish();
    await vi.waitFor(() => expect(send.mock.calls).toEqual([[10], [180]]));
  });
  it('drops pending angles after disconnect and reports failures', async () => {
    const failed = vi.fn();
    const sender = new HingeSender(async () => {
      throw new Error('offline');
    }, failed);
    sender.set(120);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    sender.stop();
    sender.set(0);
    expect(failed).toHaveBeenCalledOnce();
  });
});

describe('Duo position lock', () => {
  it.each([false, true])('keeps touch active while locked (Alt=%s)', (alt) => {
    expect(duoPointerMode(true, true, alt)).toBe('touch');
    expect(duoPointerMode(true, false, alt)).toBe('ignore');
  });
  it('allows deliberate orbit only after unlocking', () => {
    expect(duoPointerMode(false, false, false)).toBe('orbit');
    expect(duoPointerMode(false, true, false)).toBe('touch');
    expect(duoPointerMode(false, true, true)).toBe('orbit');
  });
});

describe('Duo hardware input', () => {
  it('orders a quick release after the acknowledged down event', async () => {
    let ack!: () => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            ack = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const sender = new DuoButtonSender(send, vi.fn());
    sender.press('side');
    sender.release();
    sender.release();
    await vi.waitFor(() => expect(send.mock.calls).toEqual([['side', true]]));
    ack();
    await vi.waitFor(() =>
      expect(send.mock.calls).toEqual([
        ['side', true],
        ['side', false],
      ]),
    );
  });
  it('still releases when a down event fails or times out', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined);
    const failed = vi.fn();
    const sender = new DuoButtonSender(send, failed);
    sender.press('volumeDown');
    sender.press('volumeUp');
    sender.release();
    await vi.waitFor(() =>
      expect(send.mock.calls).toEqual([
        ['volumeDown', true],
        ['volumeDown', false],
      ]),
    );
    expect(failed).toHaveBeenCalledOnce();
  });
  it('releases a button if the browser loses the pointer release', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn().mockResolvedValue(undefined);
      const sender = new DuoButtonSender(send, vi.fn());
      sender.press('volumeUp');
      await vi.advanceTimersByTimeAsync(10000);
      expect(send.mock.calls).toEqual([
        ['volumeUp', true],
        ['volumeUp', false],
      ]);
      sender.release();
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
