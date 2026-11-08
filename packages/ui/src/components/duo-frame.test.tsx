import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import DuoFrame, { type DuoFrameProps } from './duo-frame';

const rendering = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      setPixelRatio() {}
      setClearColor() {}
      setSize() {}
      render = rendering.render;
      dispose() {}
      forceContextLoss() {}
    },
    PMREMGenerator: class {
      fromEquirectangular() {
        return { texture: new actual.Texture(), dispose() {} };
      }
      dispose() {}
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rendering.render.mockClear();
});

it('keeps local camera controls available without sending watch-only device input', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    vi.stubGlobal(
      name,
      class {
        observe() {}
        disconnect() {}
      },
    );
  }
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 800));
  const props: DuoFrameProps = {
    readOnly: true,
    outer: document.createElement('video'),
    inner: document.createElement('video'),
    state: {
      angleDegrees: 0,
      minAngleDegrees: 0,
      maxAngleDegrees: 180,
      orientation: 'portrait',
      displays: [
        { id: 'outer', screenId: 1, trackId: 'outer', width: 1398, height: 2034, scale: 3, orientation: 1 },
        { id: 'inner', screenId: 2, trackId: 'inner', width: 2034, height: 2912, scale: 3, orientation: 1 },
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
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
  const animate = (time: number) => {
    const callback = frame!;
    frame = undefined;
    callback(time);
  };
  const pointer = (target: Element, type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
  };
  try {
    await act(async () => root.render(<DuoFrame {...props} />));
    const canvas = host.querySelector('canvas')!;
    const stage = canvas.parentElement!;
    stage.setPointerCapture = vi.fn();
    animate(16);
    const scene = rendering.render.mock.calls.at(-1)![0] as THREE.Scene;
    const orbit = scene.children.find((child) => child instanceof THREE.Group)!;
    const yaw = orbit.rotation.y;
    pointer(canvas, 'pointerdown', 300, 400);
    pointer(canvas, 'pointermove', 340, 420);
    pointer(canvas, 'pointerup', 340, 420);
    animate(32);
    expect(orbit.rotation.y).not.toBe(yaw);
    expect(button('Front').disabled).toBe(false);
    expect(button('Back').disabled).toBe(false);
    expect(button('Book').disabled).toBe(true);
    expect(button('Laptop view').disabled).toBe(true);
    await act(async () => button('Back').click());
    expect(button('Back').getAttribute('aria-pressed')).toBe('true');
    for (const hardware of host.querySelectorAll<HTMLButtonElement>('[data-duo-button]')) {
      expect(hardware.disabled).toBe(true);
      pointer(hardware, 'pointerdown', 300, 400);
      pointer(hardware, 'pointerup', 300, 400);
      hardware.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
      hardware.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }));
    }
    expect(props.touch).not.toHaveBeenCalled();
    expect(props.button).not.toHaveBeenCalled();
    expect(props.setAngle).not.toHaveBeenCalled();
    expect(props.setOrientation).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
