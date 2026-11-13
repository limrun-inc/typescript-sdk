import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteControl } from './remote-control';
import { defaultRemoteControlAssets } from '../frame-assets';

vi.mock('../core/device-stream', () => ({
  createDeviceStream: () => ({
    attachVideo: vi.fn(),
    start: vi.fn(),
    dispose: vi.fn(),
    updateOptions: vi.fn(),
    bumpActivity: vi.fn(),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('fits the tablet screen opening after metadata, rotation and container resizing', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const observers = new Set<() => void>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {
        observers.add(callback);
      }
      observe() {}
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
  let scale = 0.5;
  // These are the bundled artwork dimensions, rotated with the selected image.
  const frameSize = (image: HTMLImageElement) =>
    image.src.includes('landscape') ? [2798, 1837] : [1837, 2798];
  vi.spyOn(HTMLImageElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    return frameSize(this)[0]! * scale;
  });
  vi.spyOn(HTMLImageElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
    return frameSize(this)[1]! * scale;
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <RemoteControl
          url="wss://example.com/android_euna_test/ws"
          token="fixture"
          assets={defaultRemoteControlAssets}
        />,
      ),
    );
    const video = host.querySelector('video')!;
    const frame = host.querySelector('img')!;
    const setVideoSize = async (width: number, height: number, event: string) => {
      Object.defineProperties(video, {
        videoWidth: { configurable: true, value: width },
        videoHeight: { configurable: true, value: height },
      });
      await act(async () => video.dispatchEvent(new Event(event)));
      await act(async () => frame.dispatchEvent(new Event('load')));
    };
    // At half size, the visible screen is 1280 × 800, not the phone-sized 1346 × 841.
    await setVideoSize(1920, 1200, 'loadedmetadata');
    expect(frame.src).toContain('pixel_tablet_landscape');
    expect(parseFloat(video.style.width)).toBeCloseTo(1280);
    expect(video.style.height).toBe('auto');
    expect(video.style.aspectRatio).toBe('1920 / 1200');
    expect(parseFloat(video.style.borderRadius)).toBeCloseTo(16);

    await setVideoSize(1200, 1920, 'resize');
    expect(frame.src).toContain('pixel_tablet_portrait');
    expect(parseFloat(video.style.height)).toBeCloseTo(1280);
    expect(video.style.width).toBe('auto');
    expect(video.style.aspectRatio).toBe('1200 / 1920');
    expect(parseFloat(video.style.borderRadius)).toBeCloseTo(16);

    scale = 0.25;
    await act(async () => {
      for (const notify of observers) notify();
    });
    expect(parseFloat(video.style.height)).toBeCloseTo(640);
    expect(parseFloat(video.style.borderRadius)).toBeCloseTo(8);

    await setVideoSize(1920, 1200, 'resize');
    expect(parseFloat(video.style.width)).toBeCloseTo(640);
    expect(video.style.height).toBe('auto');
  } finally {
    await act(async () => root.unmount());
  }
});
