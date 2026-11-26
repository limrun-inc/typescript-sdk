import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useDeviceView, type DeviceView } from './device-view';

afterEach(() => vi.unstubAllGlobals());

function renderView(onShow3d?: () => void) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const latest: { view?: DeviceView } = {};
  function Probe() {
    latest.view = useDeviceView(onShow3d);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  return { latest, root };
}

it('shows 3D only once the 3D view for the current pick is ready', () => {
  const onShow3d = vi.fn();
  const { latest, root } = renderView(onShow3d);
  expect(latest.view).toMatchObject({ mode: '2d', shown: '2d', loading: false });
  act(() => latest.view!.choose('3d'));
  expect(latest.view).toMatchObject({ mode: '3d', shown: '2d', loading: true });
  act(() => latest.view!.onReady());
  expect(latest.view).toMatchObject({ mode: '3d', shown: '3d', loading: false });
  expect(onShow3d).toHaveBeenCalledOnce();
  // A second ready, as a 3D view rebuilt for a new stream shape reports, hands nothing over again.
  act(() => latest.view!.onReady());
  expect(onShow3d).toHaveBeenCalledOnce();
  act(() => root.unmount());
});

it('ignores a ready from an earlier pick of 3D', () => {
  const onShow3d = vi.fn();
  const { latest, root } = renderView(onShow3d);
  act(() => latest.view!.choose('3d'));
  const stale = latest.view!.onReady;
  act(() => latest.view!.choose('2d'));
  // A load that finishes after the viewer went back to 2D changes nothing.
  act(() => stale());
  expect(latest.view).toMatchObject({ mode: '2d', shown: '2d', loading: false });
  act(() => latest.view!.choose('3d'));
  // Nor does it end the new pick's loading.
  act(() => stale());
  expect(latest.view).toMatchObject({ mode: '3d', shown: '2d', loading: true });
  act(() => latest.view!.onReady());
  expect(latest.view).toMatchObject({ shown: '3d', loading: false });
  expect(onShow3d).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
