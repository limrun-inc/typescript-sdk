import { describe, expect, it, vi } from 'vitest';
import { DuoTouchController, getDuoDisplay, type DuoState } from '../core';
import {
  createDisplayTouchMessage,
  flatDisplayTouch,
  duoPointerMode,
  DuoButtonSender,
  HingeSender,
  panelTouch,
  validHingeAngle,
} from './duo';

describe('native Duo input', () => {
  it.each([
    [0, 0.2, 0.3],
    [1, 0.3, 0.8],
    [2, 0.8, 0.7],
    [3, 0.7, 0.2],
  ])('maps 2D screen coordinates back to the native panel at rotation %s', (turns, x, y) => {
    const point = flatDisplayTouch(0.2, 0.3, turns!);
    expect(point.x).toBeCloseTo(x!);
    expect(point.y).toBeCloseTo(y!);
  });
  it('keeps a captured drag inside the native panel after it leaves the screen', () => {
    expect(flatDisplayTouch(-1, 2, 1)).toEqual({ x: 1, y: 1 });
  });
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

describe('Duo viewer input', () => {
  const state: DuoState = {
    orientation: 'portrait',
    angleDegrees: 180,
    minAngleDegrees: 0,
    maxAngleDegrees: 180,
    displays: [
      { id: 'outer', screenId: 1, trackId: 'video0', width: 1398, height: 2034, scale: 3, orientation: 1 },
      { id: 'inner', screenId: 2, trackId: 'duo-inner', width: 2007, height: 2853, scale: 3, orientation: 3 },
    ],
  };

  it('releases the captured native panel before a fold, rotation, or disconnect', () => {
    const send = vi.fn();
    const input = new DuoTouchController(send);
    input.setDisplay(getDuoDisplay(state));
    input.touch('begin', 0.25, 0.5);
    expect(send).toHaveBeenLastCalledWith(0, 2, 0.5, 0.75);
    input.setDisplay(getDuoDisplay({ ...state, angleDegrees: 90 }));
    expect(send).toHaveBeenCalledTimes(1);
    input.touch('move', -1, 2);
    input.setDisplay(getDuoDisplay({ ...state, angleDegrees: 89 }));
    expect(send).toHaveBeenLastCalledWith(1, 2, 1, 1);
    input.touch('move', 0.2, 0.3);
    expect(send).toHaveBeenCalledTimes(3);
    input.touch('begin', 0.25, 0.5);
    input.setDisplay({ screenId: 1, orientation: 4 });
    expect(send).toHaveBeenLastCalledWith(1, 1, 0.25, 0.5);
    input.touch('begin', 0.25, 0.5);
    expect(send).toHaveBeenLastCalledWith(0, 1, 0.5, 0.25);
    input.setDisplay(undefined);
    expect(send).toHaveBeenLastCalledWith(1, 1, 0.5, 0.25);
    const count = send.mock.calls.length;
    input.release();
    input.touch('begin', 0, 0);
    expect(send).toHaveBeenCalledTimes(count);
    expect(input.active).toBe(false);
  });

  it('supports framed and native coordinates while keeping release edges ordered', () => {
    const send = vi.fn();
    const input = new DuoTouchController(send);
    input.setDisplay(getDuoDisplay(state), 2);
    input.touch('begin', 0.25, 0.5);
    expect(send).toHaveBeenLastCalledWith(0, 2, 0.75, 0.5);
    input.touch('begin', 0.25, 0.5, true);
    expect(send.mock.calls.slice(-2)).toEqual([
      [1, 2, 0.75, 0.5],
      [0, 2, 0.25, 0.5],
    ]);
    input.touch('end', 0.5, 0.75, true);
    expect(send).toHaveBeenLastCalledWith(1, 2, 0.5, 0.75);
    expect(input.active).toBe(false);
    input.touch('begin', 0.25, 0.5);
    input.release();
    expect(send).toHaveBeenLastCalledWith(1, 2, 0.75, 0.5);
  });
});
