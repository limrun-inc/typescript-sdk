import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import DuoView from './duo-view';
import type { DuoFrameProps } from './duo-frame';
import type { DuoOrientation } from '../core/duo';

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
    expect(host.querySelector('.rc-duo-flat-frame')).not.toBeNull();
    expect(host.querySelectorAll('.rc-duo-physical')).toHaveLength(3);
    expect(host.querySelectorAll('.rc-duo-hardware')).toHaveLength(3);
    expect(host.querySelector('[aria-label="Rotate device"]')).not.toBeNull();
    expect(host.querySelector('input[type=range]')).not.toBeNull();
    expect(host.querySelector('video')!.srcObject).toBe(outer.srcObject);
    const press = async (selector: string, type: string) => {
      await act(async () => {
        host.querySelector(selector)!.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', bubbles: true }));
      });
    };
    await press('.rc-duo-physical[data-duo-button=side]', 'keydown');
    await press('.rc-duo-physical[data-duo-button=side]', 'keyup');
    await press('.rc-duo-hardware[data-duo-button=volumeUp]', 'keydown');
    await press('.rc-duo-hardware[data-duo-button=volumeUp]', 'keyup');
    expect(props.button).toHaveBeenNthCalledWith(1, 'side', true);
    expect(props.button).toHaveBeenNthCalledWith(2, 'side', false);
    expect(props.button).toHaveBeenNthCalledWith(3, 'volumeUp', true);
    expect(props.button).toHaveBeenNthCalledWith(4, 'volumeUp', false);
    await press('.rc-duo-hardware[data-duo-button=volumeDown]', 'keydown');
    await clickMode('3D');
    expect(props.button).toHaveBeenLastCalledWith('volumeDown', false);
    expect(renderer.loaded).toHaveBeenCalledOnce();
    expect(host.querySelector('canvas')).not.toBeNull();
    await act(async () => root.render(<DuoView {...props} showFrame={false} />));
    expect(host.querySelector('.rc-duo-mode')).toBeNull();
    expect(host.querySelector('.rc-duo-flat-frame')).toBeNull();
    expect(renderer.released).toHaveBeenCalledOnce();
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.querySelector('video')!.srcObject).toBe(outer.srcObject);
    expect(props.setAngle).not.toHaveBeenCalled();
    await act(async () => root.render(<DuoView {...props} />));
    await clickMode('2D');
    await act(async () => root.render(<DuoView {...props} state={{ ...props.state, angleDegrees: 180 }} />));
    expect(host.querySelector('video')!.srcObject).toBe(inner.srcObject);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each<{
  orientation: DuoOrientation;
  rotation: number;
  outerTouch: number[];
  innerTouch: number[];
}>([
  { orientation: 'portrait', rotation: 0, outerTouch: [0.2, 0.3], innerTouch: [0.3, 0.8] },
  { orientation: 'landscape-left', rotation: 270, outerTouch: [0.7, 0.2], innerTouch: [0.2, 0.3] },
  { orientation: 'pud', rotation: 180, outerTouch: [0.8, 0.7], innerTouch: [0.7, 0.2] },
  { orientation: 'landscape-right', rotation: 90, outerTouch: [0.3, 0.8], innerTouch: [0.8, 0.7] },
])('keeps the frame and touches at $orientation across app rotations and folds', async (pose) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 600, height: 800 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
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
      angleDegrees: 180,
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
  try {
    await act(async () => root.render(<DuoView {...props} />));
    await act(async () => {
      host
        .querySelector('[aria-label="Rotate device"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.setOrientation).toHaveBeenCalledWith('landscape-left');
    // A locked app keeps its metadata unchanged after the native rotation arrives.
    for (const angleDegrees of [180, 0, 180]) {
      for (const displayOrientation of [1, 3]) {
        await act(async () =>
          root.render(
            <DuoView
              {...props}
              state={{
                ...props.state,
                angleDegrees,
                orientation: pose.orientation,
                displays: props.state.displays.map((display) => ({
                  ...display,
                  orientation: displayOrientation,
                })),
              }}
            />,
          ),
        );
        const unfolded = angleDegrees === 180;
        expect(host.querySelector<HTMLDivElement>('.rc-duo-flat-device')!.style.transform).toBe(
          `translate(-50%, -50%) rotate(${pose.rotation}deg)`,
        );
        const video = host.querySelector('video')!;
        expect(video.srcObject).toBe((unfolded ? inner : outer).srcObject);
        expect(video.style.transform).toBe(`translate(-50%, -50%) rotate(${unfolded ? 90 : 0}deg)`);
        const screen = host.querySelector<HTMLDivElement>('.rc-duo-flat-screen')!;
        screen.setPointerCapture = vi.fn();
        screen.getBoundingClientRect = () => new DOMRect(10, 20, 600, 800);
        await act(async () => {
          screen.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 130, clientY: 260 }));
          screen.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 130, clientY: 260 }));
        });
        expect(props.touch).toHaveBeenLastCalledWith(
          1,
          unfolded ? 2 : 1,
          ...(unfolded ? pose.innerTouch : pose.outerTouch),
        );
      }
    }
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([1, 2, 3, 4])('keeps a frameless display interactive at orientation %s', async (orientation) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 600, height: 800 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  const capture = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
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
        { id: 'outer', screenId: 1, trackId: 'outer', width: 1398, height: 2034, scale: 3, orientation },
        { id: 'inner', screenId: 2, trackId: 'inner', width: 2034, height: 2912, scale: 3, orientation },
      ],
    },
    setAngle: vi.fn().mockResolvedValue(undefined),
    setOrientation: vi.fn().mockResolvedValue(undefined),
    button: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn(),
    onKeyDown: vi.fn(),
    onKeyUp: vi.fn(),
  };
  const loaded = renderer.loaded.mock.calls.length;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    for (const folded of [true, false, true]) {
      await act(async () =>
        root.render(
          <DuoView {...props} showFrame={false} state={{ ...props.state, angleDegrees: folded ? 0 : 180 }} />,
        ),
      );
      expect(host.querySelector('.rc-duo-flat-frame')).toBeNull();
      expect(host.querySelector('button')).toBeNull();
      expect(host.querySelector('canvas')).toBeNull();
      expect(host.querySelector('.rc-duo-controls')).toBeNull();
      expect(host.querySelector('.rc-duo-flat-stage')!.getAttribute('data-folding')).toBe('false');
      const video = host.querySelector('video')!;
      expect(video.srcObject).toBe((folded ? outer : inner).srcObject);
      const screen = host.querySelector<HTMLDivElement>('.rc-duo-flat-screen')!;
      expect(screen.style.borderRadius).toBe('0');
      expect(screen.style.left).toBe('0px');
      expect(screen.style.top).toBe('0px');
      const nativeWidth = folded ? 1398 : 2034;
      const nativeHeight = folded ? 2034 : 2912;
      expect(parseFloat(video.style.width) / parseFloat(video.style.height)).toBeCloseTo(
        nativeWidth / nativeHeight,
      );
      const width = parseFloat(screen.style.width),
        height = parseFloat(screen.style.height);
      const rotation = host.querySelector<HTMLDivElement>('.rc-duo-flat-device')!.style.transform;
      const swapped = rotation.includes('rotate(90deg)') || rotation.includes('rotate(270deg)');
      expect(Math.max((swapped ? height : width) / 600, (swapped ? width : height) / 800)).toBeCloseTo(1);
      screen.setPointerCapture = vi.fn();
      screen.getBoundingClientRect = () => new DOMRect(0, 0, 600, 800);
      await act(async () => {
        screen.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 400 }));
        screen.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 400 }));
        screen.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
        screen.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
      });
      expect(props.touch).toHaveBeenLastCalledWith(1, folded ? 1 : 2, 0.5, 0.5);
      expect(props.onKeyDown).toHaveBeenCalled();
      expect(props.onKeyUp).toHaveBeenCalled();
    }
    expect(renderer.loaded).toHaveBeenCalledTimes(loaded);
    expect(capture).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
