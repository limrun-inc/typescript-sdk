import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DuoControls } from './duo-controls';
import { useDuoButtonHinge } from './duo-button-hinge';

let now = 0;
let nextId = 0;
const callbacks = new Map<number, FrameRequestCallback>();
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
let hinge: ReturnType<typeof useDuoButtonHinge>;
const send = vi.fn<(angle: number) => Promise<void>>();
const failed = vi.fn();
function View({ nativeAngle = 0 }: { nativeAngle?: number }) {
  hinge = useDuoButtonHinge(nativeAngle, send, failed);
  return (
    <DuoControls
      angle={hinge.angle}
      changeAngle={hinge.changeAngle}
      interacting={hinge.interacting}
      rotate={() => {}}
      onFold={hinge.fold}
      foldTarget={hinge.target}
      onHingeDrag={hinge.cancelFold}
    />
  );
}
beforeEach(() => {
  now = nextId = 0;
  callbacks.clear();
  send.mockReset().mockResolvedValue(undefined);
  failed.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(callbacks.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function advance(duration: number) {
  const until = now + duration;
  while (now < until) {
    now = Math.min(until, now + 1000 / 60);
    const frame = [...callbacks.values()];
    callbacks.clear();
    await act(async () => frame.forEach((callback) => callback(now)));
  }
}
async function clickFold() {
  await act(async () => host.querySelector<HTMLButtonElement>('.rc-duo-fold')!.click());
}
for (const from of [0, 180]) {
  it(`sends intermediate native angles from ${from} and the exact endpoint`, async () => {
    await act(async () => root.render(<View nativeAngle={from} />));
    await clickFold();
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector('.rc-duo-fold')!.textContent).toBe(from === 0 ? 'Fold' : 'Unfold');
    await advance(2700);
    const angles = send.mock.calls.map(([angle]) => angle);
    expect(angles.length).toBeGreaterThan(15);
    expect(angles.length).toBeLessThanOrEqual(77);
    expect(angles[0]).toBeGreaterThan(0);
    expect(angles[0]).toBeLessThan(180);
    expect(angles.at(-1)).toBe(180 - from);
    expect(
      angles.every((angle, i) => i === 0 || (from === 0 ? angle >= angles[i - 1]! : angle <= angles[i - 1]!)),
    ).toBe(true);
    expect(hinge.interacting.current).toBe(false);
    expect(hinge.motion.current).toBeUndefined();
  });
}
it('reverses from its current pose and lets a slider change take over', async () => {
  await act(async () => root.render(<View />));
  await clickFold();
  await advance(200);
  const previous = hinge.angle;
  await clickFold();
  expect(hinge.motion.current?.from).toBeCloseTo(previous, 8);
  expect(hinge.target).toBe(0);
  await advance(200);
  expect(hinge.angle).toBeLessThan(previous);
  await act(async () => hinge.changeAngle(110));
  const count = send.mock.calls.length;
  await advance(1500);
  expect(send).toHaveBeenLastCalledWith(110);
  expect(send).toHaveBeenCalledTimes(count);
});
it('coalesces a slow native connection without losing the endpoint', async () => {
  let release!: () => void;
  send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => root.render(<View />));
  await clickFold();
  await advance(2700);
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => release());
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith(180);
});
it('stops animation on a native failure and on unmount', async () => {
  send.mockRejectedValueOnce(new Error('HID failed'));
  await act(async () => root.render(<View />));
  await clickFold();
  await advance(100);
  expect(hinge.motion.current).toBeUndefined();
  expect(hinge.angle).toBe(0);
  expect(failed).toHaveBeenLastCalledWith('Error: HID failed');
  await clickFold();
  await advance(100);
  await act(async () => root.render(null));
  const count = send.mock.calls.length;
  await advance(2700);
  expect(send).toHaveBeenCalledTimes(count);
});
it('keeps the default 2D button as one immediate endpoint command', async () => {
  const changeAngle = vi.fn();
  await act(async () =>
    root.render(
      <DuoControls angle={0} changeAngle={changeAngle} interacting={{ current: false }} rotate={() => {}} />,
    ),
  );
  await clickFold();
  expect(changeAngle).toHaveBeenCalledExactlyOnceWith(180);
  expect(callbacks.size).toBe(0);
});
