import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteControl } from './remote-control';
import { CONTROL_MSG_TYPE, MAC_INPUT_ACTION } from '../core/constants';

const { createDeviceStream, sendControl } = vi.hoisted(() => {
  const sendControl = vi.fn();
  return {
    sendControl,
    createDeviceStream: vi.fn(() => ({
      attachVideo: vi.fn(),
      start: vi.fn(),
      dispose: vi.fn(),
      updateOptions: vi.fn(),
      bumpActivity: vi.fn(),
      pressButton: vi.fn(),
      getState: () => ({ connection: 'connected', controlReady: true, videoReady: true }),
      sendControl,
    })),
  };
});
vi.mock('../core/device-stream', () => ({ createDeviceStream }));

afterEach(() => {
  sendControl.mockClear();
  vi.unstubAllGlobals();
});

function macKeys() {
  return sendControl.mock.calls
    .map(([data]) => new DataView(data as ArrayBuffer))
    .filter((view) => view.getUint8(0) === CONTROL_MSG_TYPE.INJECT_MAC_KEY)
    .map((view) => [view.getUint8(1), view.getUint16(2, true)]);
}

async function renderMacOS(props: { showFrame?: boolean } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <RemoteControl url="wss://example.com/v1/macos_eu_test/endpointWebSocket" token="t" {...props} />,
    ),
  );
  return { host, root, video: host.querySelector('video')! };
}

it('releases the keys a macOS guest holds when the stream loses focus', async () => {
  const { host, root, video } = await renderMacOS();
  try {
    await act(async () => video.focus());
    await act(async () => {
      video.dispatchEvent(new KeyboardEvent('keydown', { code: 'MetaLeft', key: 'Meta', bubbles: true }));
      video.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
      video.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    });
    expect(macKeys()).toEqual([
      [MAC_INPUT_ACTION.DOWN, 0x37],
      [MAC_INPUT_ACTION.DOWN, 0x38],
      [MAC_INPUT_ACTION.UP, 0x38],
    ]);
    sendControl.mockClear();
    // Cmd stays down in the guest until the blur lets it go, once.
    await act(async () => video.blur());
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(macKeys()).toEqual([[MAC_INPUT_ACTION.UP, 0x37]]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('holds a desktop-shaped placeholder while a macOS stream loads', async () => {
  const { host, root, video } = await renderMacOS();
  try {
    expect(video.classList).toContain('rc-video-loading-desktop');
    expect(video.classList).not.toContain('rc-video-loading');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

function stubContainerSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('rc-container') ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('rc-container') ? height : 0;
  });
}

it('draws a MacBook Pro around the screen, fitted to the container', async () => {
  stubContainerSize(1114, 2000);
  const { host, root, video } = await renderMacOS();
  try {
    const macbook = host.querySelector<HTMLElement>('.rc-macbook')!;
    // The frame is 111.4 screen-hundredths wide, so a 1114 px container holds a 1000 px screen.
    expect(macbook.style.width).toBe('1114px');
    expect(video.style.width).toBe('1000px');
    expect(video.style.height).toBe('625px');
    expect(macbook.style.height).toBe('695px');
    expect(macbook.style.getPropertyValue('--rc-macbook-unit')).toBe('10px');
    expect(video.classList).not.toContain('rc-video-frameless');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

it('streams a macOS guest frameless without showFrame', async () => {
  stubContainerSize(1114, 2000);
  const { host, root, video } = await renderMacOS({ showFrame: false });
  try {
    expect(host.querySelector('.rc-macbook')).toBeNull();
    expect(video.classList).toContain('rc-video-frameless');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
