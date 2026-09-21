import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import DuoView from './duo-view';
import type { DuoState } from '../core/duo';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the logo until playback and does not show it again when folding', async () => {
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
  const host = document.createElement('div');
  const root = createRoot(host);
  const outer = document.createElement('video');
  const inner = document.createElement('video');
  const state: DuoState = {
    angleDegrees: 0,
    minAngleDegrees: 0,
    maxAngleDegrees: 180,
    orientation: 'portrait',
    displays: [
      { id: 'outer', screenId: 0, width: 466, height: 678, orientation: 1 },
      { id: 'inner', screenId: 1, width: 678, height: 932, orientation: 1 },
    ],
  };
  const render = (angleDegrees: number) =>
    root.render(
      <DuoView
        outer={outer}
        inner={inner}
        state={{ ...state, angleDegrees }}
        loadingLogo="/apple.svg"
        setAngle={async () => {}}
        setOrientation={async () => {}}
        button={async () => {}}
        touch={() => {}}
        onKeyDown={() => {}}
        onKeyUp={() => {}}
      />,
    );
  try {
    await act(async () => render(0));
    expect(host.querySelector('[role="status"] img')).not.toBeNull();
    const video = host.querySelector('video')!;
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => video.dispatchEvent(new Event('playing')));
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => render(180));
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
