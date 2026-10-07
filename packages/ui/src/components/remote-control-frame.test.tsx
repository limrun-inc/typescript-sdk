import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteControl } from './remote-control-framed';
import type { RemoteControlProps } from './remote-control';
import { defaultRemoteControlAssets } from '../frame-assets';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(props: Partial<RemoteControlProps> = {}) {
  await act(async () =>
    root.render(<RemoteControl url="wss://example.com/ios_test/signaling" token="test" {...props} />),
  );
  return host.querySelector('video')!;
}

async function resize(video: HTMLVideoElement, width: number, height: number, event = 'resize') {
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: width },
    videoHeight: { configurable: true, value: height },
  });
  await act(async () => video.dispatchEvent(new Event(event)));
}

it('shows an iPad frame before connecting when the model is known', async () => {
  await render({ deviceModel: 'ipad' });
  expect(host.querySelector('.rc-ipad-frame')?.getAttribute('src')).toBe(
    defaultRemoteControlAssets.ios!.tabletFrame,
  );
});

it.each([
  [1668, 2420],
  [834, 1210],
  [2064, 2752],
])('detects an iPad at %s × %s before images load and follows rotation', async (width, height) => {
  const video = await render();
  await resize(video, width, height, 'loadedmetadata');
  expect(host.querySelector('.rc-ipad-frame')?.getAttribute('src')).toBe(
    defaultRemoteControlAssets.ios!.tabletFrame,
  );
  expect(video.classList.contains('rc-video-frameless')).toBe(false);
  await resize(video, height, width);
  expect(host.querySelector('.rc-ipad-frame')?.getAttribute('src')).toBe(
    defaultRemoteControlAssets.ios!.tabletFrameLandscape,
  );
});

it('fits both video dimensions inside the iPad screen opening on rotation', async () => {
  let width = 467;
  let height = 647;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  const video = await render();
  await resize(video, 1668, 2420, 'loadedmetadata');
  expect(parseFloat(video.style.width)).toBeCloseTo(417);
  expect(parseFloat(video.style.height)).toBeCloseTo(597);
  expect(parseFloat(video.style.borderRadius)).toBeCloseTo(8.5);
  width = 647;
  height = 467;
  await resize(video, 2420, 1668);
  expect(parseFloat(video.style.width)).toBeCloseTo(597);
  expect(parseFloat(video.style.height)).toBeCloseTo(417);
  expect(parseFloat(video.style.borderRadius)).toBeCloseTo(8.5);
});

it('switches between phone, tablet and Watch without retaining frame dimensions', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(467);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(647);
  const video = await render();
  await resize(video, 1206, 2622);
  expect(video.style.width).toBe('auto');
  await resize(video, 1668, 2420);
  expect(parseFloat(video.style.width)).toBeCloseTo(417);
  await resize(video, 416, 496);
  expect(host.querySelector('.rc-phone-frame')).toBeNull();
  expect(video.style.width).toBe('');
  expect(video.style.height).toBe('');
  expect(video.style.borderRadius).toBe('');
  await resize(video, 2622, 1206);
  expect(host.querySelector('img')?.getAttribute('src')).toBe(defaultRemoteControlAssets.ios!.frameLandscape);
  expect(video.style.height).toBe('auto');
});

it.each([{ showFrame: false }, { assets: {} }, { deviceModel: 'iphone-duo' as const }])(
  'keeps frames disabled for %j',
  async (props) => {
    const video = await render(props);
    await resize(video, 1668, 2420);
    expect(host.querySelector('.rc-phone-frame')).toBeNull();
    await resize(video, 2420, 1668);
    expect(host.querySelector('.rc-phone-frame')).toBeNull();
  },
);

it('does not fall back to a custom phone frame when tablet artwork is absent', async () => {
  const video = await render({ assets: { ios: { frame: 'custom-phone.svg' } } });
  await resize(video, 1668, 2420);
  expect(host.querySelector('.rc-phone-frame')).toBeNull();
});

it('keeps Android phone and tablet frame selection', async () => {
  const video = await render({ url: 'wss://example.com/android_test/ws' });
  await resize(video, 1080, 2400);
  expect(host.querySelector('img')?.getAttribute('src')).toBe(defaultRemoteControlAssets.android!.frame);
  await resize(video, 1200, 1920);
  expect(host.querySelector('img')?.getAttribute('src')).toBe(
    defaultRemoteControlAssets.android!.tabletFrame,
  );
  await resize(video, 1920, 1200);
  expect(host.querySelector('img')?.getAttribute('src')).toBe(
    defaultRemoteControlAssets.android!.tabletFrameLandscape,
  );
});
