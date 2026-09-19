import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import DuoView from './duo-view';
import type { DuoFrameProps } from './duo-frame';

const renderer = vi.hoisted(() => ({ loaded: vi.fn(), released: vi.fn() }));
vi.mock('./duo-frame', () => {
  renderer.loaded();
  return {
    default: function Frame() {
      useEffect(() => () => renderer.released(), []);
      return <canvas />;
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('starts without a renderer, loads it on request and releases it when returning to native video', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  const outer = document.createElement('video');
  const inner = document.createElement('video');
  outer.srcObject = {} as MediaStream;
  inner.srcObject = {} as MediaStream;
  const props: DuoFrameProps = {
    outer,
    inner,
    state: {
      angleDegrees: 0,
      minAngleDegrees: 0,
      maxAngleDegrees: 180,
      orientation: 'portrait',
      displays: [
        { id: 'outer', screenId: 1, trackId: 'outer', width: 1398, height: 2034, scale: 3, orientation: 1 },
        { id: 'inner', screenId: 2, trackId: 'inner', width: 2034, height: 2912, scale: 3, orientation: 3 },
      ],
    },
    setAngle: vi.fn().mockResolvedValue(undefined),
    setOrientation: vi.fn().mockResolvedValue(undefined),
    button: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn(),
    onKeyDown: vi.fn(),
    onKeyUp: vi.fn(),
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const clickMode = async (label: string) => {
    await act(async () => {
      [...host.querySelectorAll('.rc-duo-mode button')]
        .find((b) => b.textContent === label)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<DuoView {...props} />));
    expect(renderer.loaded).not.toHaveBeenCalled();
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.querySelector('video')!.srcObject).toBe(outer.srcObject);
    await clickMode('3D');
    expect(renderer.loaded).toHaveBeenCalledOnce();
    expect(host.querySelector('canvas')).not.toBeNull();
    await clickMode('2D');
    expect(renderer.released).toHaveBeenCalledOnce();
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.querySelector('video')!.srcObject).toBe(outer.srcObject);
    expect(props.setAngle).not.toHaveBeenCalled();
    await act(async () => root.render(<DuoView {...props} state={{ ...props.state, angleDegrees: 180 }} />));
    expect(host.querySelector('video')!.srcObject).toBe(inner.srcObject);
  } finally {
    await act(async () => root.unmount());
  }
});
