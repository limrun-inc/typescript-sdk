// 3D simulator view.
//
// Renders the live device stream onto a procedurally-built 3D device model
// (see device-model.ts) with the interaction feel from the product blog
// post: the device subtly turns to face the cursor, can be grabbed and
// rotated in 3D, keeps spinning when flicked, and gently settles back to
// face the viewer (spin-dynamics.ts).
//
// This view is presentation-only: pointer events rotate the model and are
// never forwarded to the device. The host component keeps the hidden
// <video> element mounted and playing so it can be sampled here as a
// THREE.VideoTexture.

import React, { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  buildDeviceModel,
  resolveDeviceKind,
  DeviceModel,
  DeviceModelHint,
  DeviceModelKind,
  DevicePlatform3D,
} from './device-model';
import { hasRealisticModel, loadRealisticModel } from './realistic-model';
import {
  applyDrag,
  beginDrag,
  createSpinState,
  endDrag,
  stepSpin,
  tiltTargetFromPointer,
} from './spin-dynamics';
import './device-3d.css';

export interface Device3DProps {
  /**
   * The (hidden but playing) video element carrying the device stream. Read
   * lazily inside effects so the ref is populated by mount time.
   */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  platform: DevicePlatform3D;
  /**
   * Which physical device to render for iOS streams. `'auto'` (default)
   * renders an Apple Watch when the stream is nearly square and an iPhone
   * otherwise; pass `'watch'` / `'phone'` to force it.
   */
  deviceModel?: DeviceModelHint;
  className?: string;
}

// Maximum cursor-follow tilt (radians) — subtle, like the blog describes.
const MAX_CURSOR_TILT = 0.16; // ~9°

// Full-width / full-height drag rotations (radians).
const DRAG_YAW_GAIN = Math.PI * 1.1;
const DRAG_PITCH_GAIN = Math.PI * 0.75;

// Default portrait screen aspects used until the stream reports its
// intrinsic size (9:19.5 for a modern phone, ~0.83 for an Apple Watch).
const FALLBACK_PORTRAIT_ASPECT = 9 / 19.5;
const FALLBACK_WATCH_ASPECT = 416 / 496;

// Extra margin around the model's bounding sphere when fitting the camera.
const FIT_MARGIN = 1.12;

export const Device3D: React.FC<Device3DProps> = ({
  videoRef,
  platform,
  deviceModel = 'auto',
  className,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [grabbing, setGrabbing] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const video = videoRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      // WebGL unavailable (old browser, blocked context). The host keeps
      // showing the 2D view semantics; we just surface a notice.
      console.warn('RemoteControl: 3D view unavailable, WebGL context creation failed.', error);
      setWebglFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.className = 'rc-3d-canvas';
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);

    // Soft studio environment gives the metal frame and glass their
    // reflections — this is what makes the device "catch the light" as it
    // turns.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(2.5, 3, 4);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xdfe8ff, 0.5);
    fillLight.position.set(-3, -1, 2.5);
    scene.add(fillLight);

    // --- Model lifecycle -------------------------------------------------
    let model: DeviceModel | null = null;
    let texture: THREE.VideoTexture | null = null;
    let kind: DeviceModelKind = resolveDeviceKind(platform, deviceModel, null);
    let portraitAspect = kind === 'watch' ? FALLBACK_WATCH_ASPECT : FALLBACK_PORTRAIT_ASPECT;
    let landscape = false;

    const fitCamera = () => {
      if (!model) return;
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const radius = model.boundingRadius * FIT_MARGIN;
      const distance = radius / Math.sin(Math.min(vFov, hFov) / 2);
      camera.position.set(0, 0, distance);
      camera.lookAt(0, 0, 0);
    };

    // Bumped on every rebuild/unmount so a photoreal model that finishes
    // loading late (kind changed, component gone) is discarded, not shown.
    let modelGeneration = 0;

    const installModel = (next: DeviceModel) => {
      if (model) {
        scene.remove(model.group);
        model.dispose();
      }
      model = next;
      model.setLandscape(landscape);
      model.setScreenTexture(texture);
      model.group.rotation.order = 'YXZ';
      scene.add(model.group);
      fitCamera();
    };

    const rebuildModel = () => {
      const generation = ++modelGeneration;
      // The procedural model shows instantly; the photoreal GLB (a lazily
      // imported ~1MB chunk) swaps in when ready. On load failure the
      // procedural model simply stays.
      installModel(buildDeviceModel(kind, portraitAspect));
      if (hasRealisticModel(kind)) {
        loadRealisticModel(kind).then(
          (realistic) => {
            if (generation !== modelGeneration) {
              realistic.dispose();
              return;
            }
            installModel(realistic);
          },
          (error) => {
            console.warn('RemoteControl: photoreal 3D model unavailable, keeping procedural model.', error);
          },
        );
      }
    };

    // Adopt the stream's intrinsic dimensions: orientation flips rotate the
    // physical model; a genuinely different aspect (or a device-kind change,
    // e.g. auto-detecting a watch stream) rebuilds it.
    const syncVideoDimensions = () => {
      if (!video || !video.videoWidth || !video.videoHeight) return;
      const w = video.videoWidth;
      const h = video.videoHeight;
      const nextLandscape = w > h;
      const nextPortraitAspect = Math.min(w, h) / Math.max(w, h);
      const nextKind = resolveDeviceKind(platform, deviceModel, nextPortraitAspect);
      const needsRebuild = Math.abs(nextPortraitAspect - portraitAspect) > 1e-3 || nextKind !== kind;
      portraitAspect = nextPortraitAspect;
      kind = nextKind;
      if (needsRebuild) {
        landscape = nextLandscape;
        rebuildModel();
        return;
      }
      if (nextLandscape !== landscape) {
        landscape = nextLandscape;
        model?.setLandscape(landscape);
        fitCamera();
      }
    };

    const ensureTexture = () => {
      if (texture || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      model?.setScreenTexture(texture);
    };

    const handleVideoReady = () => {
      syncVideoDimensions();
      ensureTexture();
    };
    video?.addEventListener('loadeddata', handleVideoReady);
    video?.addEventListener('loadedmetadata', handleVideoReady);
    // Orientation changes mid-stream fire 'resize' on the video element.
    video?.addEventListener('resize', handleVideoReady);

    rebuildModel();
    handleVideoReady();

    // --- Interaction -------------------------------------------------------
    const spin = createSpinState();
    // Normalized cursor position in [-1, 1]; null when the pointer is
    // outside, which lets the device settle to dead-center.
    let hover: { nx: number; ny: number } | null = null;
    let dragPointerId: number | null = null;
    let lastDrag: { x: number; y: number; time: number } | null = null;

    const normalizePointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { nx: 0, ny: 0 };
      return {
        nx: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        ny: ((event.clientY - rect.top) / rect.height) * 2 - 1,
      };
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      event.preventDefault();
      dragPointerId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      lastDrag = { x: event.clientX, y: event.clientY, time: performance.now() };
      beginDrag(spin);
      setGrabbing(true);
    };

    const handlePointerMove = (event: PointerEvent) => {
      hover = normalizePointer(event);
      if (dragPointerId === null || event.pointerId !== dragPointerId || !lastDrag) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const now = performance.now();
      const dt = (now - lastDrag.time) / 1000;
      const deltaYaw = ((event.clientX - lastDrag.x) / rect.width) * DRAG_YAW_GAIN;
      const deltaPitch = ((event.clientY - lastDrag.y) / rect.height) * DRAG_PITCH_GAIN;
      applyDrag(spin, deltaYaw, deltaPitch, dt);
      lastDrag = { x: event.clientX, y: event.clientY, time: now };
    };

    const releaseDrag = (event: PointerEvent) => {
      if (dragPointerId === null || event.pointerId !== dragPointerId) return;
      dragPointerId = null;
      lastDrag = null;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      endDrag(spin);
      setGrabbing(false);
    };

    const handlePointerLeave = (event: PointerEvent) => {
      if (event.pointerId === dragPointerId) return; // capture keeps the drag alive
      hover = null;
    };

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', releaseDrag);
    canvas.addEventListener('pointercancel', releaseDrag);
    canvas.addEventListener('pointerleave', handlePointerLeave);

    // --- Sizing ------------------------------------------------------------
    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      fitCamera();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    // --- Render loop ---------------------------------------------------------
    let rafId = 0;
    let lastTime = performance.now();
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      ensureTexture();

      const target =
        hover ? tiltTargetFromPointer(hover.nx, hover.ny, MAX_CURSOR_TILT) : { yaw: 0, pitch: 0 };
      stepSpin(spin, target, dt);
      if (model) {
        model.group.rotation.set(spin.pitch, spin.yaw, 0);
      }
      renderer.render(scene, camera);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      modelGeneration++;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', releaseDrag);
      canvas.removeEventListener('pointercancel', releaseDrag);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      video?.removeEventListener('loadeddata', handleVideoReady);
      video?.removeEventListener('loadedmetadata', handleVideoReady);
      video?.removeEventListener('resize', handleVideoReady);
      if (model) {
        scene.remove(model.group);
        model.dispose();
      }
      texture?.dispose();
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      canvas.remove();
    };
    // The videoRef object identity is stable; the element is read at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, deviceModel]);

  return (
    <div
      ref={hostRef}
      className={clsx('rc-3d-layer', grabbing && 'rc-3d-grabbing', className)}
      data-testid="rc-3d-layer"
    >
      {webglFailed && <div className="rc-3d-unavailable">3D view requires WebGL</div>}
    </div>
  );
};
