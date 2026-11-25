import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  MACBOOK_LID_OPEN,
  MACBOOK_LID_OPENING_MS,
  MACBOOK_VERTEX_FLOATS,
  lidOpeningAngle,
  macbookMeshes,
  streamFit,
  streamPoint,
  type MacbookKind,
} from './macbook-geometry';
import { createStudioEnvironment } from './studio-environment';

export interface MacbookFrameProps {
  video: HTMLVideoElement | null;
  /** The screen's aspect ratio, which the stream sets. */
  aspect: number;
  watchOnly?: boolean;
  /** A desktop pointer event at a point of the screen, 0 to 1 from its top left. */
  pointer: (action: 'down' | 'move' | 'up', x: number, y: number, buttons: number) => void;
  /** A scroll at a point of the screen, in CSS pixels as WheelEvent reports them. */
  scroll: (x: number, y: number, deltaX: number, deltaY: number) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  onKeyUp: React.KeyboardEventHandler<HTMLDivElement>;
  /** The stage lost focus, so every key the guest holds must go up. */
  onBlur: () => void;
  /**
   * A prepared MacBook model to draw instead of the built-in one, supplied and licensed by the
   * host; scripts/prepare-macbook-model.mjs describes the nodes it must have.
   */
  modelUrl?: string;
  /** Opens the lid when the MacBook appears, unless the viewer prefers reduced motion. */
  animateLid?: boolean;
}

type View = 'front' | 'desk' | 'side';
// Yaw and pitch of each view, in radians: pitch looks down onto the keyboard, yaw turns the MacBook.
const VIEWS: Record<View, { yaw: number; pitch: number; label: string }> = {
  front: { yaw: 0, pitch: 0.1, label: 'Front' },
  desk: { yaw: -0.5, pitch: 0.42, label: 'Desk' },
  side: { yaw: -1.15, pitch: 0.16, label: 'Side' },
};
const FOV = 28;

function material(kind: MacbookKind, screen: THREE.Material): THREE.Material {
  const side = THREE.DoubleSide;
  switch (kind) {
    case 'screen':
      return screen;
    case 'shell':
      return new THREE.MeshStandardMaterial({ color: 0x34353a, metalness: 0.9, roughness: 0.34, side });
    case 'glass':
      return new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.06, clearcoat: 1, side });
    case 'camera':
      return new THREE.MeshStandardMaterial({ color: 0x0c1015, roughness: 0.2, side });
    case 'well':
      return new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.9, side });
    case 'keys':
      return new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.7, side });
    case 'trackpad':
      return new THREE.MeshPhysicalMaterial({
        color: 0x2c2d31,
        metalness: 0.4,
        roughness: 0.3,
        clearcoat: 0.6,
        side,
      });
    case 'scoop':
      return new THREE.MeshStandardMaterial({ color: 0x18181b, metalness: 0.6, roughness: 0.5, side });
  }
}

// Layers drawn on another surface win its depth test however far the camera is.
const LAYER: Partial<Record<MacbookKind, number>> = {
  glass: 1,
  camera: 2,
  screen: 2,
  well: 1,
  keys: 2,
  trackpad: 1,
  scoop: 1,
};

/** The MacBook in 3D with the stream on its screen. The screen takes the guest's pointer. */
export default function MacbookFrame(props: MacbookFrameProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>('front');
  const viewRef = useRef(view);
  viewRef.current = view;
  const viewRevision = useRef(0);
  const [positionLocked, setPositionLocked] = useState(false);
  const lockedRef = useRef(positionLocked);
  lockedRef.current = positionLocked;
  const invalidateFrame = useRef<() => void>(() => undefined);

  useEffect(() => invalidateFrame.current(), [view, positionLocked]);

  useEffect(() => {
    const container = host.current;
    const video = props.video;
    if (!container || !video) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setError('3D rendering is unavailable in this browser. Enable WebGL to use the 3D MacBook.');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const environmentMap = createStudioEnvironment(renderer);
    scene.environment = environmentMap.texture;
    scene.environmentIntensity = 0.45;
    scene.add(new THREE.HemisphereLight(0xffffff, 0xc1c8d1, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-120, 220, 260);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xe4edff, 0.7);
    rim.position.set(220, 40, -220);
    scene.add(rim);
    const camera = new THREE.PerspectiveCamera(FOV, 1, 10, 4000);

    const screenTexture = new THREE.VideoTexture(video);
    screenTexture.colorSpace = THREE.SRGBColorSpace;
    screenTexture.minFilter = THREE.LinearFilter;
    screenTexture.magFilter = THREE.LinearFilter;
    screenTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // The stream keeps its shape on a display of another shape, and the glass around it stays black.
    // Two-sided, since a prepared model's display may be wound either way.
    const screenMaterial = new THREE.MeshBasicMaterial({
      map: screenTexture,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    screenMaterial.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        if (any(lessThan(vMapUv, vec2(0.0))) || any(greaterThan(vMapUv, vec2(1.0)))) diffuseColor.rgb = vec3(0.0);`,
      );
    };
    screenMaterial.customProgramCacheKey = () => 'macbook-fitted-screen';
    // The display's aspect ratio: the stream's for the built-in model, the panel's for a prepared one.
    let screenAspect = latest.current.aspect;
    let fit = streamFit(screenAspect, screenAspect);
    const fitStream = () => {
      const videoAspect =
        video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : screenAspect;
      fit = streamFit(videoAspect, screenAspect);
      screenTexture.repeat.set(fit.repeat[0], fit.repeat[1]);
      screenTexture.offset.set(fit.offset[0], fit.offset[1]);
    };

    // The model turns as a whole for the view; the lid turns about the hinge, the x axis.
    const root = new THREE.Group();
    const model = new THREE.Group();
    const lid = new THREE.Group();
    lid.rotation.x = MACBOOK_LID_OPEN;
    model.add(lid);
    root.add(model);
    scene.add(root);
    const resources: { dispose(): void }[] = [screenMaterial];
    // The built-in model's parts, released once a prepared model replaces them.
    const builtIn: { dispose(): void }[] = [];
    let screenMesh: THREE.Mesh | undefined;
    for (const mesh of macbookMeshes(latest.current.aspect)) {
      const geometry = new THREE.BufferGeometry();
      const buffer = new THREE.InterleavedBuffer(mesh.vertices, MACBOOK_VERTEX_FLOATS);
      geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
      geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
      geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(buffer, 2, 6));
      const surface = material(mesh.kind, screenMaterial);
      const layer = LAYER[mesh.kind];
      if (layer) {
        surface.polygonOffset = true;
        surface.polygonOffsetFactor = -layer;
        surface.polygonOffsetUnits = -layer;
      }
      const object = new THREE.Mesh(geometry, surface);
      if (mesh.kind === 'screen') screenMesh = object;
      (mesh.part === 'lid' ? lid : model).add(object);
      builtIn.push(geometry);
      if (surface !== screenMaterial) builtIn.push(surface);
    }

    // The model turns about the center it has when open, and the camera frames it open, so the
    // view holds still while the lid opens.
    const bounds = new THREE.Box3();
    const openBounds = (object: THREE.Object3D) => {
      const angle = lid.rotation.x;
      lid.rotation.x = MACBOOK_LID_OPEN;
      object.updateMatrixWorld(true);
      bounds.setFromObject(object);
      lid.rotation.x = angle;
      return bounds;
    };
    const center = () => {
      root.rotation.set(0, 0, 0);
      model.position.set(0, 0, 0);
      model.position.copy(openBounds(root).getCenter(new THREE.Vector3())).negate();
    };
    center();

    // The lid opens once the model to open is ready: the prepared one when it loads, or the
    // built-in one. The MacBook stays hidden until then.
    let openingStart: number | undefined;
    const reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const show = () => {
      root.visible = true;
      if (latest.current.animateLid !== false && !reducedMotion) {
        openingStart = performance.now();
        lid.rotation.x = lidOpeningAngle(0);
      }
      invalidate();
    };

    // A prepared model replaces the built-in one once it loads; until then, or if it fails, the
    // built-in one stays.
    const loadModel = async (url: string) => {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/libs/meshopt_decoder.module.js'),
      ]);
      const { scene: imported } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
      imported.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        resources.push(object.geometry);
        for (const surface of Array.isArray(object.material) ? object.material : [object.material]) {
          resources.push(surface);
          for (const value of Object.values(surface))
            if (value instanceof THREE.Texture) resources.push(value);
        }
      });
      if (disposed) return;
      const importedBase = imported.getObjectByName('macbook-base');
      const importedLid = imported.getObjectByName('macbook-lid');
      const importedScreen = imported.getObjectByName('macbook-screen');
      if (!importedBase || !importedLid || !(importedScreen instanceof THREE.Mesh)) {
        throw new Error('it has no macbook-base, macbook-lid or macbook-screen');
      }
      for (const child of [...model.children]) if (child !== lid) model.remove(child);
      lid.clear();
      model.add(importedBase);
      for (const child of [...importedLid.children]) lid.add(child);
      importedScreen.material = screenMaterial;
      screenMesh = importedScreen;
      const panel = importedScreen.userData['aspect'];
      if (typeof panel === 'number' && panel > 0) screenAspect = panel;
      for (const resource of builtIn.splice(0)) resource.dispose();
      center();
    };
    const modelUrl = latest.current.modelUrl;
    if (modelUrl) {
      root.visible = false;
      loadModel(modelUrl)
        .catch((reason) => {
          if (!disposed)
            setError(
              `The MacBook model could not load: ${reason instanceof Error ? reason.message : reason}`,
            );
        })
        .finally(() => {
          if (!disposed) show();
        });
    }
    const extent = new THREE.Vector3();
    let distance = 0;

    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let drag:
      | { pointer: number; kind: 'screen' | 'orbit'; clientX: number; clientY: number; x: number; y: number }
      | undefined;
    let yaw = 0;
    let pitch = 0;
    let renderedYaw = VIEWS[viewRef.current].yaw;
    let renderedPitch = VIEWS[viewRef.current].pitch;
    let previousRevision = viewRevision.current;
    let aspect = 1;
    let animation = 0;
    let lastTime = 0;
    let disposed = false;
    let visible = true;
    const invalidate = () => {
      if (!animation && visible && !document.hidden && !disposed) animation = requestAnimationFrame(animate);
    };
    invalidateFrame.current = invalidate;

    // The point of the screen under the pointer, 0 to 1 from its top left, if it is on the screen.
    const screenPoint = (event: PointerEvent | WheelEvent) => {
      if (!screenMesh) return undefined;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      );
      ray.setFromCamera(pointer, camera);
      const uv = ray.intersectObject(screenMesh, false)[0]?.uv;
      // The display's point in the stream, which may not fill it.
      return uv && streamPoint(uv.x, uv.y, fit);
    };
    const down = (event: PointerEvent) => {
      invalidate();
      if (drag) return;
      const point = latest.current.watchOnly || event.altKey ? undefined : screenPoint(event);
      if (!point && (lockedRef.current || event.button !== 0)) return;
      container.focus({ preventScroll: true });
      container.setPointerCapture(event.pointerId);
      drag = {
        pointer: event.pointerId,
        kind: point ? 'screen' : 'orbit',
        clientX: event.clientX,
        clientY: event.clientY,
        x: point?.x ?? 0,
        y: point?.y ?? 0,
      };
      if (point) latest.current.pointer('down', point.x, point.y, event.buttons);
    };
    const move = (event: PointerEvent) => {
      invalidate();
      if (!drag) {
        const point = latest.current.watchOnly ? undefined : screenPoint(event);
        // The guest draws its own cursor on the screen.
        renderer.domElement.style.cursor = point ? 'none' : '';
        if (point) latest.current.pointer('move', point.x, point.y, 0);
        return;
      }
      if (drag.pointer !== event.pointerId) return;
      if (drag.kind === 'screen') {
        // A drag that leaves the screen holds its last point there until it is released.
        const point = screenPoint(event);
        if (point) {
          drag.x = point.x;
          drag.y = point.y;
        }
        latest.current.pointer('move', drag.x, drag.y, event.buttons);
      } else {
        yaw += (event.clientX - drag.clientX) * 0.008;
        pitch = THREE.MathUtils.clamp(pitch + (event.clientY - drag.clientY) * 0.008, -1.2, 1.2);
      }
      drag.clientX = event.clientX;
      drag.clientY = event.clientY;
    };
    const up = (event?: PointerEvent) => {
      invalidate();
      if (!drag || (event && drag.pointer !== event.pointerId)) return;
      if (drag.kind === 'screen') latest.current.pointer('up', drag.x, drag.y, event?.buttons ?? 0);
      drag = undefined;
    };
    const wheel = (event: WheelEvent) => {
      if (latest.current.watchOnly || event.ctrlKey) return;
      const point = screenPoint(event);
      if (!point) return;
      event.preventDefault();
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? container.clientHeight
        : 1;
      latest.current.scroll(point.x, point.y, event.deltaX * scale, event.deltaY * scale);
    };
    // RemoteControl reads mouse, touch and wheel events on its container to drive the 2D stream.
    // The stage handles its own, so none of them may reach it.
    const contain = (event: Event) => event.stopPropagation();
    const contained = [
      'mousedown',
      'mousemove',
      'mouseup',
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
    ];
    for (const type of contained) container.addEventListener(type, contain);
    const contextMenu = (event: Event) => event.preventDefault();
    const blur = () => {
      up();
      latest.current.onBlur();
    };
    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);
    container.addEventListener('lostpointercapture', up);
    container.addEventListener('wheel', wheel, { passive: false });
    container.addEventListener('wheel', contain);
    container.addEventListener('contextmenu', contextMenu);
    container.addEventListener('focusout', blur);
    window.addEventListener('blur', blur);

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      aspect = w / h;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const animate = (time: number) => {
      animation = 0;
      if (disposed || !visible || document.hidden) return;
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      if (viewRevision.current !== previousRevision) {
        yaw = 0;
        pitch = 0;
        previousRevision = viewRevision.current;
      }
      const target = VIEWS[viewRef.current];
      // Only the lid moves as it opens; the MacBook and the view stay where they are.
      let opening = false;
      if (openingStart !== undefined) {
        const progress = (time - openingStart) / MACBOOK_LID_OPENING_MS;
        lid.rotation.x = lidOpeningAngle(progress);
        if (progress >= 1) openingStart = undefined;
        else opening = true;
      }
      const targetYaw = target.yaw + yaw;
      const targetPitch = target.pitch + pitch;
      renderedYaw = THREE.MathUtils.damp(renderedYaw, targetYaw, 10, dt);
      renderedPitch = THREE.MathUtils.damp(renderedPitch, targetPitch, 10, dt);
      if (Math.abs(renderedYaw - targetYaw) < 0.0005) renderedYaw = targetYaw;
      if (Math.abs(renderedPitch - targetPitch) < 0.0005) renderedPitch = targetPitch;
      fitStream();
      root.rotation.set(renderedPitch, renderedYaw, 0, 'XYZ');
      // Frame the turned model's bounds, leaving a margin around them.
      openBounds(root).getSize(extent);
      const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      const fit = Math.max(extent.y / 2 / tan, extent.x / 2 / (tan * aspect)) * 1.12 + extent.z / 2;
      distance = distance ? THREE.MathUtils.damp(distance, fit, 10, dt) : fit;
      if (Math.abs(distance - fit) < 0.01) distance = fit;
      camera.position.set(0, 0, distance);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      if (opening || renderedYaw !== targetYaw || renderedPitch !== targetPitch || distance !== fit)
        invalidate();
    };
    // The screen repaints with each new frame of the stream.
    let videoCallback: number | undefined;
    const frame = () => {
      if (disposed) return;
      invalidate();
      videoCallback = video.requestVideoFrameCallback(frame);
    };
    if ('requestVideoFrameCallback' in video) videoCallback = video.requestVideoFrameCallback(frame);
    const fallback =
      'requestVideoFrameCallback' in video ? undefined : window.setInterval(invalidate, 1000 / 30);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      invalidate();
    });
    intersection.observe(container);
    document.addEventListener('visibilitychange', invalidate);
    resize();
    if (!modelUrl) show();

    return () => {
      disposed = true;
      invalidateFrame.current = () => undefined;
      up();
      cancelAnimationFrame(animation);
      if (videoCallback !== undefined) video.cancelVideoFrameCallback(videoCallback);
      clearInterval(fallback);
      intersection.disconnect();
      observer.disconnect();
      document.removeEventListener('visibilitychange', invalidate);
      for (const type of contained) container.removeEventListener(type, contain);
      container.removeEventListener('pointerdown', down);
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', up);
      container.removeEventListener('pointercancel', up);
      container.removeEventListener('lostpointercapture', up);
      container.removeEventListener('wheel', wheel);
      container.removeEventListener('wheel', contain);
      container.removeEventListener('contextmenu', contextMenu);
      container.removeEventListener('focusout', blur);
      window.removeEventListener('blur', blur);
      for (const resource of [...resources, ...builtIn]) resource.dispose();
      screenTexture.dispose();
      environmentMap.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [props.video, props.aspect, props.modelUrl]);

  return (
    // The Duo's 3D styles serve every 3D device frame.
    <div className="rc-duo rc-macbook-3d">
      <div
        ref={host}
        className="rc-duo-stage"
        data-position-locked={positionLocked}
        tabIndex={0}
        role="application"
        aria-label="MacBook running macOS. Use the screen to control the guest. Drag around the MacBook to turn it when position is unlocked."
        onKeyDown={props.onKeyDown}
        onKeyUp={props.onKeyUp}
      />
      <div className="rc-duo-controls" onPointerDown={(event) => event.stopPropagation()}>
        <div className="rc-duo-views">
          {(Object.keys(VIEWS) as View[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => {
                viewRevision.current++;
                setView(value);
              }}
            >
              {VIEWS[value].label}
            </button>
          ))}
          <button
            type="button"
            className="rc-duo-lock"
            aria-pressed={positionLocked}
            title={
              positionLocked ?
                'Position is locked. The screen still controls macOS.'
              : 'Drag around the MacBook to turn it. Alt-drag turns it from the screen.'
            }
            onClick={() => setPositionLocked(!positionLocked)}
          >
            {positionLocked ? 'Position locked' : 'Lock position'}
          </button>
        </div>
      </div>
      {error && (
        <div role="alert" className="rc-duo-error">
          {error}
        </div>
      )}
    </div>
  );
}
