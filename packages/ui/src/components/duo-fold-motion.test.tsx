import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DuoFoldMotion, useDuoFoldMotion } from './duo-fold-motion';
import { flatFrameGeometry } from './duo-flat-geometry';
import type { DuoOrientation } from '../core/duo';

const renderer = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
  finish: undefined as undefined | (() => void),
}));
vi.mock('./duo-fold-renderer', () => ({ renderFold: renderer.start }));
let ready: VideoFrameRequestCallback | undefined;
let reduced = false;
const video = document.createElement('video');
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
let prepareFold: (inner: boolean) => void;
const cancel = vi.fn();
const draw = vi.fn();
const readPixels = vi.fn();
const changePreference = new EventTarget();
function View({
  inner = false,
  width = 600,
  turns,
  orientation = 'portrait',
}: {
  inner?: boolean;
  width?: number;
  turns?: number;
  orientation?: DuoOrientation;
}) {
  const { motion, finish, prepare } = useDuoFoldMotion(
    { current: video },
    inner,
    flatFrameGeometry(inner, turns ?? (inner ? 1 : 0), width, 700),
    orientation,
  );
  prepareFold = prepare;
  return motion && <DuoFoldMotion motion={motion} onFinish={finish} />;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  reduced = false;
  ready = undefined;
  cancel.mockClear();
  draw.mockClear();
  readPixels.mockClear();
  renderer.start.mockReset();
  renderer.dispose.mockClear();
  renderer.start.mockImplementation((_canvas, _motion, finish) => {
    renderer.finish = finish;
    return renderer.dispose;
  });
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reduced;
    },
    addEventListener: changePreference.addEventListener.bind(changePreference),
    removeEventListener: changePreference.removeEventListener.bind(changePreference),
  }));
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 4 },
    videoWidth: { configurable: true, value: 1398 },
    videoHeight: { configurable: true, value: 2034 },
    requestVideoFrameCallback: {
      configurable: true,
      value: (callback: VideoFrameRequestCallback) => {
        ready = callback;
        return 1;
      },
    },
    cancelVideoFrameCallback: { configurable: true, value: cancel },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
    getImageData: readPixels,
  } as unknown as CanvasRenderingContext2D);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function incoming() {
  await act(async () => ready!(0, {} as VideoFrameCallbackMetadata));
}
it('loads the renderer only for a confirmed fold and disposes it when finished', async () => {
  await act(async () => root.render(<View />));
  expect(renderer.start).not.toHaveBeenCalled();
  expect(draw).not.toHaveBeenCalled();
  await act(async () => root.render(<View inner />));
  expect(host.querySelector('.rc-duo-fold-hold')).not.toBeNull();
  await incoming();
  expect(renderer.start).toHaveBeenCalledTimes(1);
  const motion = renderer.start.mock.calls[0]![1];
  expect(Math.max(motion.before.width, motion.before.height)).toBeLessThanOrEqual(1024);
  expect(Math.max(motion.after.width, motion.after.height)).toBeLessThanOrEqual(1024);
  await act(async () => renderer.finish!());
  expect(host.childElementCount).toBe(0);
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});
it('cancels on resize and ignores a late frame callback', async () => {
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner />));
  const late = ready!;
  await act(async () => root.render(<View inner width={400} />));
  await act(async () => late(0, {} as VideoFrameCallbackMetadata));
  expect(host.childElementCount).toBe(0);
  expect(renderer.start).not.toHaveBeenCalled();
});
it('disposes an interrupted fold before starting its reverse', async () => {
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner />));
  await incoming();
  await act(async () => root.render(<View />));
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  await incoming();
  expect(renderer.start).toHaveBeenCalledTimes(2);
  await act(async () => renderer.finish!());
  expect(host.childElementCount).toBe(0);
});
it('skips GPU work with reduced motion and cancels when the preference changes', async () => {
  reduced = true;
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner />));
  expect(draw).not.toHaveBeenCalled();
  expect(renderer.start).not.toHaveBeenCalled();
  reduced = false;
  await act(async () => root.render(<View />));
  await incoming();
  reduced = true;
  await act(async () => changePreference.dispatchEvent(new Event('change')));
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(host.childElementCount).toBe(0);
});
it('starts on the first incoming frame without brightness checks or timer delays', async () => {
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner />));
  expect(renderer.start).not.toHaveBeenCalled();
  expect(host.querySelector('.rc-duo-fold-hold')).not.toBeNull();
  await incoming();
  expect(renderer.start).toHaveBeenCalledTimes(1);
  expect(readPixels).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('uses the settled native orientation without rotating the entire phone', async () => {
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner turns={0} />));
  await act(async () => root.render(<View inner turns={1} />));
  await incoming();
  const motion = renderer.start.mock.calls[0]![1];
  expect(motion.to.frame.turns).toBe(0);
  expect(motion.from.frame.turns).toBe(0);
});
for (const fromInner of [false, true]) {
  for (const pose of [0, 1, 2, 3]) {
    it(`uses the incoming geometry when ${fromInner ? 'folding' : 'unfolding'} at pose ${pose}`, async () => {
      const fromTurns = (pose + (fromInner ? 1 : 0)) % 4;
      const toTurns = (pose + (fromInner ? 0 : 1)) % 4;
      await act(async () => root.render(<View inner={fromInner} turns={fromTurns} />));
      await act(async () => root.render(<View inner={!fromInner} turns={fromTurns} />));
      await act(async () => root.render(<View inner={!fromInner} turns={toTurns} />));
      await incoming();
      expect(renderer.start).toHaveBeenCalledTimes(1);
      const motion = renderer.start.mock.calls[0]![1];
      expect(motion.from.frame.turns).toBe(pose);
      expect(motion.to.frame.turns).toBe(pose);
      expect(motion.to.frame.scale).toBe(flatFrameGeometry(!fromInner, toTurns, 600, 700).scale);
      await act(async () => renderer.finish!());
      expect(renderer.dispose).toHaveBeenCalledTimes(1);
    });
  }
}
it('uses incoming geometry even when its rotation differs from the outgoing panel', async () => {
  await act(async () => root.render(<View inner turns={0} />));
  await act(async () => root.render(<View turns={0} />));
  await incoming();
  const motion = renderer.start.mock.calls[0]![1];
  expect(motion.from.frame.turns).toBe(3);
  expect(motion.to.frame.turns).toBe(0);
  expect(motion.to.frame.scale).toBe(flatFrameGeometry(false, 0, 600, 700).scale);
});
it('still cancels an active fold when the device is explicitly rotated', async () => {
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner />));
  await incoming();
  await act(async () => root.render(<View inner turns={2} orientation="landscape-left" />));
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(host.childElementCount).toBe(0);
});
it('waits for a usable frame if a video event precedes its dimensions', async () => {
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner />));
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 0 });
  await incoming();
  expect(renderer.start).not.toHaveBeenCalled();
  expect(host.querySelector('.rc-duo-fold-hold')).not.toBeNull();
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1398 });
  await incoming();
  expect(renderer.start).toHaveBeenCalledTimes(1);
});
it('returns to live video on missing frames or WebGL failure', async () => {
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner />));
  Object.defineProperty(video, 'readyState', { configurable: true, value: 0 });
  await act(async () => vi.advanceTimersByTime(2500));
  expect(host.childElementCount).toBe(0);
  Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
  renderer.start.mockImplementation(() => {
    throw new Error('WebGL unavailable');
  });
  await act(async () => root.render(<View />));
  await incoming();
  expect(host.childElementCount).toBe(0);
});

it('captures before the native command can blank the outgoing display', async () => {
  await act(async () => root.render(<View />));
  await act(async () => prepareFold(true));
  expect(host.querySelector('.rc-duo-fold-hold')).not.toBeNull();
  const outgoingCaptures = () => draw.mock.calls.filter(([source]) => source === video).length;
  expect(outgoingCaptures()).toBe(1);
  await act(async () => root.render(<View inner />));
  expect(outgoingCaptures()).toBe(1);
  await incoming();
  expect(renderer.start).toHaveBeenCalledTimes(1);
});
it('releases a prepared image when a command never changes the native display', async () => {
  await act(async () => root.render(<View />));
  await act(async () => prepareFold(true));
  await act(async () => vi.advanceTimersByTime(5000));
  expect(host.childElementCount).toBe(0);
  expect(renderer.start).not.toHaveBeenCalled();
});

it('accepts a black first frame without waiting for a brighter one', async () => {
  await act(async () => root.render(<View />));
  await act(async () => root.render(<View inner />));
  readPixels.mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 255]) });
  await incoming();
  expect(renderer.start).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
