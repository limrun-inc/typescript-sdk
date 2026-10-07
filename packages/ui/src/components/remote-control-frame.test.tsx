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
  // Frame layout must work before signaling connects and before the image loads.
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

it.each([
  ['iPad Pro 11', 1668, 2420],
  ['iPad Pro 13', 2064, 2752],
  ['downscaled iPad', 834, 1210],
  ['Watch', 416, 496],
] as const)(
  'renders %s frameless in both orientations, even before the frame image loads',
  async (_, width, height) => {
    const video = await render();
    expect(host.querySelector('.rc-phone-frame')).not.toBeNull();
    await resize(video, width, height, 'loadedmetadata');
    expect(host.querySelector('.rc-phone-frame')).toBeNull();
    expect(video.classList.contains('rc-video-frameless')).toBe(true);
    expect(video.style.height).toBe('');
    expect(video.style.borderRadius).toBe('');
    await resize(video, height, width);
    expect(host.querySelector('.rc-phone-frame')).toBeNull();
    expect(video.classList.contains('rc-video-frameless')).toBe(true);
  },
);

it('clears phone sizing for an iPad and restores the frame when switching back to a phone', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(650);
  const video = await render();
  await resize(video, 1206, 2622, 'loadedmetadata');
  expect(video.style.height).not.toBe('');
  expect(video.style.borderRadius).not.toBe('');
  await render({ url: 'wss://example.com/ios_ipad/signaling' });
  await resize(video, 1668, 2420);
  expect(host.querySelector('.rc-phone-frame')).toBeNull();
  expect(video.style.height).toBe('');
  expect(video.style.borderRadius).toBe('');
  await render({ url: 'wss://example.com/ios_phone/signaling' });
  await resize(video, 2622, 1206);
  expect(host.querySelector('img')?.getAttribute('src')).toBe(defaultRemoteControlAssets.ios!.frameLandscape);
  expect(video.classList.contains('rc-video-frameless')).toBe(false);
  expect(video.style.width).not.toBe('');
});

it.each([
  [1206, 2622],
  [603, 1311],
] as const)('keeps the iPhone frame at %s × %s and follows rotation', async (width, height) => {
  const video = await render();
  await resize(video, width, height, 'loadedmetadata');
  expect(host.querySelector('img')?.getAttribute('src')).toBe(defaultRemoteControlAssets.ios!.frame);
  await resize(video, height, width);
  expect(host.querySelector('img')?.getAttribute('src')).toBe(defaultRemoteControlAssets.ios!.frameLandscape);
});

it.each([{ showFrame: false }, { assets: {} }, { deviceModel: 'iphone-duo' as const }])(
  'does not add a phone frame when disabled or using Duo: %j',
  async (props) => {
    const video = await render(props);
    await resize(video, 1206, 2622, 'loadedmetadata');
    expect(host.querySelector('.rc-phone-frame')).toBeNull();
    await resize(video, 2622, 1206);
    expect(host.querySelector('.rc-phone-frame')).toBeNull();
  },
);

it('keeps Android phone and tablet frames and follows tablet rotation', async () => {
  const video = await render({ url: 'wss://example.com/android_test/ws' });
  await resize(video, 1080, 2400, 'loadedmetadata');
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
