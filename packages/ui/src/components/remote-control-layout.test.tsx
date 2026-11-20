import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteControl } from './remote-control';
import { defaultRemoteControlAssets } from '../frame-assets';

const { createDeviceStream } = vi.hoisted(() => ({
  createDeviceStream: vi.fn(() => ({
    attachVideo: vi.fn(),
    start: vi.fn(),
    dispose: vi.fn(),
    updateOptions: vi.fn(),
    bumpActivity: vi.fn(),
  })),
}));
vi.mock('../core/device-stream', () => ({ createDeviceStream }));

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

it.each([
  // Simulator's chrome around a 375 × 667 screen with square corners, drawn at 3x.
  { model: 'iphone-se', art: 'iphonese', frame: [1287, 2667], screen: 667 / 889, radius: 0 },
  // A 390 × 844 screen with rounded corners in a 452 × 888 frame, drawn at 3x.
  { model: 'iphone-17e', art: 'iphone17e', frame: [1356, 2664], screen: 844 / 888, radius: 47.33 / 452 },
] as const)(
  'fits the $model screen opening in portrait and landscape',
  async ({ model, art, frame, screen, radius }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const [frameWidth, frameHeight] = frame;
    const scale = 0.5;
    const frameSize = (image: HTMLImageElement) =>
      image.src.includes('landscape') ? [frameHeight, frameWidth] : [frameWidth, frameHeight];
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
            url="wss://example.com/ios_euna_test/ws"
            token="fixture"
            deviceModel={model}
            assets={defaultRemoteControlAssets}
          />,
        ),
      );
      const video = host.querySelector('video')!;
      const img = host.querySelector('img')!;
      const setVideoSize = async (width: number, height: number, event: string) => {
        Object.defineProperties(video, {
          videoWidth: { configurable: true, value: width },
          videoHeight: { configurable: true, value: height },
        });
        await act(async () => video.dispatchEvent(new Event(event)));
        await act(async () => img.dispatchEvent(new Event('load')));
      };
      await setVideoSize(750, 1334, 'loadedmetadata');
      expect(img.src).toContain(`${art}_black_bg`);
      expect(parseFloat(video.style.height)).toBeCloseTo(frameHeight * scale * screen);
      expect(parseFloat(video.style.borderRadius)).toBeCloseTo(frameWidth * scale * radius);

      await setVideoSize(1334, 750, 'resize');
      expect(img.src).toContain(`${art}_black_landscape_bg`);
      expect(parseFloat(video.style.width)).toBeCloseTo(frameHeight * scale * screen);
      expect(parseFloat(video.style.borderRadius)).toBeCloseTo(frameWidth * scale * radius);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it('streams a framed iOS model frameless when the assets lack its frame', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    const { modelFrames: _, ...ios } = defaultRemoteControlAssets.ios!;
    await act(async () =>
      root.render(
        <RemoteControl
          url="wss://example.com/ios_euna_test/ws"
          token="fixture"
          deviceModel="iphone-se"
          assets={{ ...defaultRemoteControlAssets, ios }}
        />,
      ),
    );
    // The default iPhone frame has the wrong shape for an SE, so no frame is drawn at all.
    expect(host.querySelector('img[src*="iphone16pro"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps the live stream when only the frame model changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  createDeviceStream.mockClear();
  const host = document.createElement('div');
  const root = createRoot(host);
  // A host may learn the model after the stream connects, e.g. from the instance's labels.
  const render = (deviceModel?: 'iphone-se' | 'iphone-17e') =>
    act(async () =>
      root.render(
        <RemoteControl
          url="wss://example.com/ios_euna_test/ws"
          token="fixture"
          deviceModel={deviceModel}
          assets={defaultRemoteControlAssets}
        />,
      ),
    );
  try {
    await render();
    await render('iphone-se');
    await render('iphone-17e');
    expect(createDeviceStream).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
