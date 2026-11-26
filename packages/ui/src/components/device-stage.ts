import { useCallback, useRef, useState } from 'react';
import * as THREE from 'three';
import { createStudioEnvironment } from './studio-environment';

/** A device's studio light: the environment's strength, a sky fill, a key light and a rim light. */
export interface StageLighting {
  environment: number;
  hemisphere: number;
  key: { intensity: number; position: [number, number, number] };
  rim: { intensity: number; position: [number, number, number] };
}

export interface DeviceStageOptions {
  /** The element the canvas fills. */
  container: HTMLElement;
  /** The streams on the device's screens: a new frame of any of them draws the scene again. */
  videos: HTMLVideoElement[];
  maxPixelRatio: number;
  lighting: StageLighting;
  /** The container changed size, in CSS pixels. */
  resize(width: number, height: number): void;
  /** Draws one frame, `dt` seconds after the last, and says whether anything still moves. */
  frame(time: number, dt: number): boolean;
}

/**
 * A 3D device frame's stage: the WebGL canvas, its studio light, and a render loop that draws only
 * when something changes, a stream's new frame included, and never while the stage is out of view
 * or the page hidden. The iPhone Duo and the MacBook each put their model and camera on one.
 */
export interface DeviceStage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** The studio environment, for materials that reflect it explicitly. */
  environment: THREE.Texture;
  /** Asks for a frame. */
  invalidate(): void;
  /** Starts sizing and drawing, once the device's own state exists. */
  start(): void;
  dispose(): void;
}

/** Creates a stage, or returns undefined where the browser has no WebGL. */
export function createDeviceStage(options: DeviceStageOptions): DeviceStage | undefined {
  const { container, videos, lighting } = options;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return undefined;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const environmentMap = createStudioEnvironment(renderer);
  scene.environment = environmentMap.texture;
  scene.environmentIntensity = lighting.environment;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc1c8d1, lighting.hemisphere));
  const key = new THREE.DirectionalLight(0xffffff, lighting.key.intensity);
  key.position.set(...lighting.key.position);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xe4edff, lighting.rim.intensity);
  rim.position.set(...lighting.rim.position);
  scene.add(rim);

  let animation = 0;
  let lastTime = 0;
  let visible = true;
  let disposed = false;
  const invalidate = () => {
    if (!animation && visible && !document.hidden && !disposed) animation = requestAnimationFrame(animate);
  };
  const animate = (time: number) => {
    animation = 0;
    if (disposed || !visible || document.hidden) return;
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;
    if (options.frame(time, dt)) invalidate();
  };
  const sizeToContainer = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;
    options.resize(width, height);
    renderer.setSize(width, height, false);
    invalidate();
  };

  const observer = new ResizeObserver(sizeToContainer);
  const intersection = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    invalidate();
  });
  const videoCallbacks = new Map<HTMLVideoElement, number>();
  let fallback: number | undefined;
  let started = false;

  return {
    renderer,
    scene,
    environment: environmentMap.texture,
    invalidate,
    start() {
      if (started || disposed) return;
      started = true;
      // The screens repaint with each new frame of their streams.
      for (const video of videos) {
        if (!('requestVideoFrameCallback' in video)) continue;
        const frame = () => {
          if (disposed) return;
          invalidate();
          videoCallbacks.set(video, video.requestVideoFrameCallback(frame));
        };
        videoCallbacks.set(video, video.requestVideoFrameCallback(frame));
      }
      if (videos.some((video) => !('requestVideoFrameCallback' in video))) {
        fallback = window.setInterval(invalidate, 1000 / 30);
      }
      observer.observe(container);
      intersection.observe(container);
      document.addEventListener('visibilitychange', invalidate);
      sizeToContainer();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(animation);
      for (const [video, id] of videoCallbacks) video.cancelVideoFrameCallback(id);
      clearInterval(fallback);
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', invalidate);
      environmentMap.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

/**
 * A 3D frame's view presets, its position lock, and the turn the viewer has dragged it to on top of
 * the preset. Picking a preset clears the drag, so the preset shows as designed.
 */
export function useStageView<View extends string>(initial: View) {
  const [view, setView] = useState(initial);
  const [locked, setLocked] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const orbit = useRef({ yaw: 0, pitch: 0 }).current;
  const chooseView = useCallback(
    (next: View) => {
      orbit.yaw = 0;
      orbit.pitch = 0;
      setView(next);
    },
    [orbit],
  );
  /** Turns the view by a drag of `dx` and `dy` CSS pixels, tilting at most `limit` radians. */
  const drag = useCallback(
    (dx: number, dy: number, limit: number) => {
      orbit.yaw += dx * 0.008;
      orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.008, -limit, limit);
    },
    [orbit],
  );
  return { view, viewRef, chooseView, locked, lockedRef, setLocked, orbit, drag };
}
