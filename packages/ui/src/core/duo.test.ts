import { describe, expect, it, vi } from 'vitest';
import { createDisplayTouchMessage, HingeSender, panelTouch, validHingeAngle } from './duo';

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
