import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CarPlayView } from './carplay-view';

const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
const touch = vi.fn();
const setEnabled = vi.fn();
const setViewing = vi.fn();
const video = createRef<HTMLVideoElement>();
const state = {
  supported: true,
  enabled: true,
  display: {
    id: 'carplay' as const,
    screenId: 2,
    trackId: 'carplay',
    width: 800,
    height: 480,
    scale: 2,
    orientation: 1,
  },
};
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  touch.mockReset();
  setEnabled.mockReset();
  setViewing.mockReset();
  root = createRoot(host);
  await act(async () =>
    root.render(
      <CarPlayView
        video={video}
        state={state}
        viewing
        pending={false}
        setEnabled={setEnabled}
        setViewing={setViewing}
        touch={touch}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('routes captured drags to CarPlay and releases cancelled touches', async () => {
  const element = video.current!;
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  element.getBoundingClientRect = () => ({ left: 20, top: 40, width: 400, height: 240 }) as DOMRect;
  const dispatch = async (type: string, x: number, y: number, id = 1) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: id });
    await act(async () => element.dispatchEvent(event));
  };
  await dispatch('pointerdown', 220, 160);
  await dispatch('pointerdown', 100, 100, 2);
  await dispatch('pointermove', 500, 0);
  await dispatch('pointercancel', 500, 0);
  await dispatch('lostpointercapture', 500, 0);
  expect(touch.mock.calls).toEqual([
    [0, 2, 0.5, 0.5],
    [2, 2, 1, 0],
    [3, 2, 1, 0],
  ]);
});

it('switches views without disconnecting and reports control errors accessibly', async () => {
  const buttons = host.querySelectorAll('button');
  await act(async () => buttons[0]!.click());
  expect(setViewing).toHaveBeenCalledWith(false);
  expect(setEnabled).not.toHaveBeenCalled();
  await act(async () => buttons[1]!.click());
  expect(setEnabled).toHaveBeenCalledWith(false);
  await act(async () =>
    root.render(
      <CarPlayView
        video={video}
        state={state}
        viewing
        pending
        error="Simulator disconnected"
        setEnabled={setEnabled}
        setViewing={setViewing}
        touch={touch}
      />,
    ),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Simulator disconnected');
  expect(host.querySelectorAll('button')[1]!.disabled).toBe(true);
});
