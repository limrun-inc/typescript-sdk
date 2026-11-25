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

async function renderMacOS(props: { showFrame?: boolean; animateLid?: boolean } = {}) {
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

// The lid opens only in the 3D mode, on the 3D model.
it('shows the 2D MacBook already open', async () => {
  stubContainerSize(1114, 2000);
  const { host, root, video } = await renderMacOS();
  try {
    expect(host.querySelector('canvas')).toBeNull();
    // The frame sits 22 pixels low, below the 2D and 3D switch.
    expect(host.querySelector<HTMLElement>('.rc-macbook')!.style.transform).toBe('translateY(22px)');
    expect(video.style.transform).toBe('translate(-50%, calc(-50% - -11px))');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

it('switches the MacBook to 3D, handing the stream to it', async () => {
  stubContainerSize(1114, 2000);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const { host, root, video } = await renderMacOS({ animateLid: false });
  try {
    const switcher = host.querySelector('[aria-label="MacBook rendering"]')!;
    const [flat, deep] = [...switcher.querySelectorAll('button')];
    expect(flat!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => deep!.click());
    expect(deep!.getAttribute('aria-pressed')).toBe('true');
    // The 2D frame goes, and the video only feeds the 3D screen.
    expect(host.querySelector('.rc-macbook')).toBeNull();
    expect(video.style.opacity).toBe('0');
    expect(video.style.pointerEvents).toBe('none');
    // jsdom has no WebGL, so the 3D MacBook says so instead of drawing.
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('WebGL'));
    await act(async () => flat!.click());
    expect(host.querySelector('.rc-macbook')).not.toBeNull();
    expect(video.style.opacity).toBe('');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

it('sets the lid of the 3D MacBook from its slider and button', async () => {
  stubContainerSize(1114, 2000);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const { host, root } = await renderMacOS({ animateLid: false });
  try {
    const deep = host.querySelectorAll<HTMLButtonElement>('[aria-label="MacBook rendering"] button')[1]!;
    await act(async () => deep.click());
    const slider = await vi.waitFor(() => host.querySelector<HTMLInputElement>('input[type="range"]')!);
    const output = () => host.querySelector('.rc-duo-hinge output')!.textContent;
    const toggle = () => host.querySelector<HTMLButtonElement>('.rc-duo-hinge .rc-duo-fold')!;
    expect(slider.max).toBe('135');
    expect(output()).toBe('100°');
    expect(toggle().textContent).toBe('Close');
    // React tracks the input's value, so set it the way a browser does before the input event.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(slider, '20');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(output()).toBe('20°');
    expect(toggle().textContent).toBe('Open');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

it('streams a macOS guest without the switch when the frame is off', async () => {
  stubContainerSize(1114, 2000);
  const { host, root } = await renderMacOS({ showFrame: false });
  try {
    expect(host.querySelector('[aria-label="MacBook rendering"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

// The slider can only be dragged when nothing cancels the press on it.
it('leaves presses on the 3D controls to the browser', async () => {
  stubContainerSize(1114, 2000);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const { host, root } = await renderMacOS({ animateLid: false });
  try {
    const deep = host.querySelectorAll<HTMLButtonElement>('[aria-label="MacBook rendering"] button')[1]!;
    await act(async () => deep.click());
    const slider = await vi.waitFor(() => host.querySelector<HTMLInputElement>('input[type="range"]')!);
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => slider.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

it('puts the stream in the screen opening of a rendered MacBook image', async () => {
  // A 2000 × 1600 image whose opening spans the middle half of its width and the top half of its height.
  stubContainerSize(1000, 844);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(1600);
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
  const assets = {
    macos: { frame: 'data:image/webp;base64,', screen: { left: 0.25, top: 0.1, width: 0.5, height: 0.5 } },
  };
  await act(async () =>
    root.render(
      <RemoteControl url="wss://example.com/v1/macos_eu_test/endpointWebSocket" token="t" assets={assets} />,
    ),
  );
  try {
    const image = host.querySelector<HTMLImageElement>('img.rc-macbook-image')!;
    await act(async () => image.dispatchEvent(new Event('load')));
    const video = host.querySelector('video')!;
    // The image fits the 800 pixels below the switch: 1000 × 800.
    expect(image.style.width).toBe('1000px');
    expect(image.style.height).toBe('800px');
    expect(image.style.transform).toBe('translateY(22px)');
    expect(host.querySelector('.rc-macbook')).toBeNull();
    // The opening is 500 × 400, its center 0 across and 400 × (0.35 - 0.5) + 22 down from the middle.
    expect(video.style.width).toBe('500px');
    expect(video.style.height).toBe('400px');
    const [dx, dy] = [...video.style.transform.matchAll(/([-\d.]+)px/g)].map((m) => Number(m[1]));
    expect(dx).toBeCloseTo(0, 6);
    expect(dy).toBeCloseTo(-98, 6);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

// A phone or tablet has no hover and no wheel: a finger is the left button, two fingers scroll.
it('turns touches on a macOS guest into presses, drags and scrolls', async () => {
  stubContainerSize(1114, 2000);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1600);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1000);
  const rect = { left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, x: 0, y: 0 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...rect, toJSON: () => rect });
  const { host, root, video } = await renderMacOS({ animateLid: false });
  const touch = async (type: string, points: [number, number][]) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const touches = points.map(([clientX, clientY]) => ({ clientX, clientY }));
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : touches });
    Object.defineProperty(event, 'changedTouches', { value: touches });
    await act(async () => video.dispatchEvent(event));
  };
  const sent = () =>
    sendControl.mock.calls.map(([data]) => {
      const view = new DataView(data as ArrayBuffer);
      if (view.getUint8(0) === CONTROL_MSG_TYPE.INJECT_MOUSE_EVENT) {
        return [
          'pointer',
          view.getUint8(1),
          view.getInt32(2, true),
          view.getInt32(6, true),
          view.getInt32(14, true),
        ];
      }
      if (view.getUint8(0) === CONTROL_MSG_TYPE.INJECT_MAC_SCROLL) {
        return [
          'scroll',
          view.getInt32(1, true),
          view.getInt32(5, true),
          view.getFloat32(13, true),
          view.getFloat32(17, true),
        ];
      }
      return ['other'];
    });
  try {
    sendControl.mockClear();
    // A tap at the middle of the 800 × 500 view is a click at the middle of the 1600 × 1000 guest.
    await touch('touchstart', [[400, 250]]);
    await touch('touchmove', [[410, 260]]);
    await touch('touchend', [[410, 260]]);
    expect(sent()).toEqual([
      ['pointer', MAC_INPUT_ACTION.DOWN, 800, 500, 1],
      ['pointer', MAC_INPUT_ACTION.MOVE, 820, 520, 1],
      ['pointer', MAC_INPUT_ACTION.UP, 820, 520, 0],
    ]);
    sendControl.mockClear();
    // Two fingers moving up scroll the content up, as on a trackpad.
    await touch('touchstart', [
      [300, 300],
      [500, 300],
    ]);
    await touch('touchmove', [
      [300, 280],
      [500, 280],
    ]);
    await touch('touchend', []);
    expect(sent()).toEqual([['scroll', 800, 560, 0, 20]]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
