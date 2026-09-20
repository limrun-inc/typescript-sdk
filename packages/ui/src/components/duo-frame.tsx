import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { createDuoModel } from './duo-model';
import { duoFoldAngle } from './duo-fold-timing';
import { hardwareLayout, hardwareHoverEdge } from './duo-hardware';
import { DuoControls, DuoHardwareIcon } from './duo-controls';
import { useDuoButtonHinge } from './duo-button-hinge';
import {
  panelTouch,
  duoPointerMode,
  DuoButtonSender,
  DUO_BUTTONS,
  type DuoButton,
  type DuoState,
  type DuoOrientation,
} from '../core/duo';

export interface DuoFrameProps {
  modelUrl?: string;
  outer: HTMLVideoElement | null;
  inner: HTMLVideoElement | null;
  state: DuoState;
  setAngle: (degrees: number) => Promise<void>;
  setOrientation: (orientation: DuoOrientation) => Promise<void>;
  button: (button: DuoButton, down: boolean) => Promise<void>;
  touch: (action: number, screenId: number, x: number, y: number) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  onKeyUp: React.KeyboardEventHandler<HTMLDivElement>;
}

type View = 'front' | 'book' | 'table' | 'back';

/** A procedural titanium frame. Each glass panel carries its own native video texture. */
export default function DuoFrame(props: DuoFrameProps) {
  const host = useRef<HTMLDivElement>(null);
  const hardwareNodes = useRef(new Map<DuoButton, HTMLButtonElement>());
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState<string>();
  const { angle, changeAngle, interacting, motion, target, fold, cancelFold } = useDuoButtonHinge(
    props.state.angleDegrees,
    props.setAngle,
    setError,
  );
  const angleRef = useRef(angle);
  angleRef.current = angle;
  const [view, setView] = useState<View>('front');
  const viewRevision = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [positionLocked, setPositionLocked] = useState(false);
  const lockedRef = useRef(positionLocked);
  lockedRef.current = positionLocked;
  const invalidateFrame = useRef<() => void>(() => undefined);

  useEffect(() => {
    invalidateFrame.current();
  }, [angle, target, view, positionLocked, props.state.orientation]);

  useEffect(() => {
    const container = host.current;
    if (!container || !props.outer || !props.inner) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setError('3D rendering is unavailable in this browser. Enable WebGL to use the folding frame.');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-150, 150, 150, -150, 1, 2000);
    let aspect = 1;
    camera.position.set(0, 0, 340);
    const root = new THREE.Group();
    // Continuous light-to-dark studio sweeps give broad metal faces reflections at every viewing angle.
    const studioWidth = 512;
    const studioHeight = 256;
    const studioPixels = new Float32Array(studioWidth * studioHeight * 4);
    for (let y = 0; y < studioHeight; y++) {
      const latitude = ((y + 0.5) / studioHeight - 0.5) * Math.PI;
      for (let x = 0; x < studioWidth; x++) {
        const longitude = ((x + 0.5) / studioWidth) * Math.PI * 2;
        const sweep = Math.pow(0.5 + 0.5 * Math.sin(4 * longitude + 1.8 * Math.sin(latitude)), 3);
        const fill = Math.pow(0.5 + 0.5 * Math.cos(2 * longitude - 3 * latitude), 3);
        const light = 0.12 + 3.2 * sweep + 0.8 * fill;
        const offset = (y * studioWidth + x) * 4;
        studioPixels.set([light, light, light, 1], offset);
      }
    }
    const studio = new THREE.DataTexture(
      studioPixels,
      studioWidth,
      studioHeight,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    studio.mapping = THREE.EquirectangularReflectionMapping;
    studio.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environmentMap = pmrem.fromEquirectangular(studio);
    scene.environment = environmentMap.texture;
    scene.environmentIntensity = 0.4;
    studio.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff, 0xc1c8d1, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-100, 180, 260);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xe4edff, 0.8);
    rim.position.set(200, -40, -200);
    scene.add(rim);
    const outerTexture = new THREE.VideoTexture(props.outer);
    const innerTexture = new THREE.VideoTexture(props.inner);
    for (const texture of [outerTexture, innerTexture]) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
    }

    const model = createDuoModel(outerTexture, innerTexture, environmentMap.texture);
    const { device } = model;
    if (props.modelUrl)
      void model
        .loadAppearance(props.modelUrl)
        .then(() => invalidate())
        .catch((reason) => setError(String(reason)));
    const buttons = new DuoButtonSender(
      (button, down) => latest.current.button(button, down),
      (reason) => setError(String(reason)),
    );
    root.add(device);
    scene.add(root);

    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let drag:
      | {
          pointer: number;
          button?: DuoButton;
          screenId?: number;
          x: number;
          y: number;
          clientX: number;
          clientY: number;
        }
      | undefined;
    let yaw = 0,
      pitch = 0;
    let previousViewRevision = viewRevision.current;
    let renderedAngle = angleRef.current;
    let foldFrom = renderedAngle;
    let foldTarget = renderedAngle;
    let foldStartedAt = 0;
    let foldDragging = false;
    let renderedYaw = 0;
    let animation = 0;
    let visible = true;
    let disposed = false;
    const invalidate = () => {
      if (!animation && visible && !document.hidden && !disposed) animation = requestAnimationFrame(animate);
    };
    invalidateFrame.current = invalidate;
    let lastTime = 0;
    let layout: ReturnType<typeof hardwareLayout> | undefined;
    let hoveredEdge: ReturnType<typeof hardwareHoverEdge>;
    const iconButton = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLButtonElement>('[data-duo-button]') : null;
    const showEdge = (edge: typeof hoveredEdge) => {
      hoveredEdge = edge;
      for (const guide of layout?.guides ?? []) {
        const element = hardwareNodes.current.get(guide.button);
        if (element) element.dataset.visible = String(guide.edge === edge);
      }
    };
    const pick = (event: PointerEvent) => {
      const icon = iconButton(event.target);
      if (icon) return { button: icon.dataset.duoButton as DuoButton };
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      );
      ray.setFromCamera(pointer, camera);
      const intersection = model.pick(ray);
      const button = intersection?.object.userData['button'] as DuoButton | undefined;
      if (button) return { button };
      if (!intersection?.object.userData['display']) return undefined;
      if (!intersection.uv) return undefined;
      const display = latest.current.state.displays.find(
        (d) => d.id === intersection.object.userData['display'],
      );
      if (!display) return undefined;
      return { screenId: display.screenId, ...panelTouch(intersection.uv.x, intersection.uv.y) };
    };
    const down = (event: PointerEvent) => {
      invalidate();
      if (drag || event.button !== 0) return;
      if (!iconButton(event.target)) container.focus({ preventScroll: true });
      const picked = pick(event);
      const hardware = picked && 'button' in picked ? picked.button : undefined;
      const mode = duoPointerMode(lockedRef.current, !!picked && !hardware, event.altKey);
      if (mode === 'ignore' && !hardware) return;
      const hit = mode === 'touch' && picked && 'screenId' in picked ? picked : undefined;
      drag = {
        pointer: event.pointerId,
        button: hardware,
        ...hit,
        x: hit?.x ?? 0,
        y: hit?.y ?? 0,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      container.setPointerCapture(event.pointerId);
      if (hardware) {
        setError(undefined);
        buttons.press(hardware);
        model.highlightButton(hardware, true);
      } else if (hit) latest.current.touch(0, hit.screenId, hit.x, hit.y);
    };
    const move = (event: PointerEvent) => {
      invalidate();
      if (!drag) {
        const hit = pick(event);
        const button = hit && 'button' in hit ? hit.button : undefined;
        const rect = container.getBoundingClientRect();
        showEdge(
          button ?
            layout?.guides.find((guide) => guide.button === button)?.edge
          : layout && hardwareHoverEdge(event.clientX - rect.left, event.clientY - rect.top, layout.rect),
        );
        renderer.domElement.style.cursor = button ? 'pointer' : '';
        renderer.domElement.title = button ? DUO_BUTTONS[button] : '';
        model.highlightButton(button);
        return;
      }
      if (drag.pointer !== event.pointerId || drag.button) return;
      if (drag.screenId) {
        const hit = pick(event);
        if (hit && 'screenId' in hit && hit.screenId === drag.screenId) {
          drag.x = hit.x;
          drag.y = hit.y;
          latest.current.touch(2, hit.screenId, hit.x, hit.y);
        }
      } else if (!lockedRef.current) {
        yaw += (event.clientX - drag.clientX) * 0.008;
        pitch = THREE.MathUtils.clamp(pitch + (event.clientY - drag.clientY) * 0.008, -1.4, 1.4);
      }
      drag.clientX = event.clientX;
      drag.clientY = event.clientY;
    };
    const up = (event?: PointerEvent) => {
      invalidate();
      if (!drag || (event && drag.pointer !== event.pointerId)) return;
      if (drag.button) {
        buttons.release();
        model.highlightButton();
      } else if (drag.screenId) latest.current.touch(1, drag.screenId, drag.x, drag.y);
      drag = undefined;
      if (event) move(event);
    };
    const leave = () => {
      invalidate();
      if (!drag) {
        model.highlightButton();
        showEdge(undefined);
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      invalidate();
      const icon = iconButton(event.target);
      if (!icon) return;
      event.stopPropagation();
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      event.preventDefault();
      if (event.repeat) return;
      const button = icon.dataset.duoButton as DuoButton;
      buttons.press(button);
      model.highlightButton(button, true);
      icon.dataset.pressed = 'true';
    };
    const keyUp = (event: KeyboardEvent) => {
      invalidate();
      const icon = iconButton(event.target);
      if (!icon) return;
      event.stopPropagation();
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      event.preventDefault();
      buttons.release();
      model.highlightButton(icon.dataset.duoButton as DuoButton);
      icon.dataset.pressed = 'false';
    };
    const focus = (event: FocusEvent) => {
      const icon = iconButton(event.target);
      if (icon) showEdge(layout?.guides.find((guide) => guide.button === icon.dataset.duoButton)?.edge);
    };
    const blur = () => {
      invalidate();
      up();
      buttons.release();
      model.highlightButton();
      showEdge(undefined);
      hardwareNodes.current.forEach((element) => {
        element.dataset.pressed = 'false';
      });
    };
    const focusOut = (event: FocusEvent) => {
      if (!container.contains(event.relatedTarget as Node | null)) blur();
      else if (iconButton(event.target)) {
        buttons.release();
        model.highlightButton();
      }
    };
    container.addEventListener('pointerleave', leave);
    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);
    container.addEventListener('lostpointercapture', up);
    container.addEventListener('keydown', keyDown);
    container.addEventListener('keyup', keyUp);
    container.addEventListener('focusin', focus);
    container.addEventListener('focusout', focusOut);
    window.addEventListener('blur', blur);
    const resize = () => {
      const w = container.clientWidth,
        h = container.clientHeight;
      if (!w || !h) return;
      aspect = w / h;

      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    const bounds = new THREE.Box3();
    const center = new THREE.Vector3();
    const extent = new THREE.Vector3();
    const animate = (time: number) => {
      animation = 0;
      if (disposed || !visible || document.hidden) return;
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      if (viewRevision.current !== previousViewRevision) {
        yaw = 0;
        pitch = 0;
        previousViewRevision = viewRevision.current;
      }
      if (foldTarget !== angleRef.current) {
        foldFrom = renderedAngle;
        foldTarget = angleRef.current;
        foldStartedAt = time;
        foldDragging = interacting.current;
      }
      const buttonFold = motion.current;
      renderedAngle =
        buttonFold ? duoFoldAngle(buttonFold.from, buttonFold.target, (time - buttonFold.startedAt) / 1000)
        : foldDragging ? THREE.MathUtils.damp(renderedAngle, foldTarget, 18, dt)
        : duoFoldAngle(foldFrom, foldTarget, (time - foldStartedAt) / 1000);
      if (Math.abs(renderedAngle - angleRef.current) < 0.001) renderedAngle = angleRef.current;
      model.setAngle(renderedAngle);
      // Closed view presents the cover; intermediate poses retain depth and true occlusion.
      const closed = 1 - THREE.MathUtils.smoothstep(renderedAngle, 15, 110);
      const baseYaw = (closed * Math.PI) / 2 + (viewRef.current === 'back' ? Math.PI : 0);
      renderedYaw = THREE.MathUtils.damp(renderedYaw, baseYaw, 12, dt);
      if (Math.abs(renderedYaw - baseYaw) < 0.001) renderedYaw = baseYaw;
      // Camera orbit stays independent of the native device orientation.
      root.rotation.set(
        pitch +
          (viewRef.current === 'table' ? -0.35
          : viewRef.current === 'book' ? 0.2
          : 0),
        yaw + (viewRef.current === 'book' ? -0.2 : 0),
        0,
      );
      // Apply screen rotation after turning the device over so the cover remains upright.
      device.rotation.set(
        0,
        renderedYaw,
        { portrait: 0, pud: Math.PI, 'landscape-left': Math.PI / 2, 'landscape-right': -Math.PI / 2 }[
          latest.current.state.orientation
        ] ?? 0,
        'ZYX',
      );
      root.position.set(0, 0, 0);
      root.updateMatrixWorld(true);
      model.getBounds(bounds).getCenter(center);
      bounds.getSize(extent);
      root.position.copy(center).negate();
      // Parallel projection keeps the far leaf's buttons visible when the device is closed.
      const width = container.clientWidth;
      const height = container.clientHeight;
      const usableWidth = Math.max(0.4, 1 - 108 / width);
      const usableHeight = Math.min(0.8, Math.max(0.35, 1 - 108 / height));
      const halfHeight = Math.max(extent.y / (2 * usableHeight), extent.x / (2 * aspect * usableWidth));
      camera.top = THREE.MathUtils.damp(camera.top, halfHeight, 14, dt);
      if (Math.abs(camera.top - halfHeight) < 0.001) camera.top = halfHeight;
      camera.bottom = -camera.top;
      camera.left = -camera.top * aspect;
      camera.right = camera.top * aspect;
      camera.updateProjectionMatrix();

      const buttonsMoving = model.animateButtons(dt);
      renderer.render(scene, camera);
      model.getBounds(bounds);
      layout = hardwareLayout(model.buttonAnchors(), bounds, camera, width, height);
      for (const guide of layout.guides) {
        const element = hardwareNodes.current.get(guide.button);
        if (!element) continue;
        element.style.left = `${guide.x}px`;
        element.style.top = `${guide.y}px`;
        element.style.setProperty('--duo-hardware-icon-size', `${layout.iconSize}px`);
        element.dataset.visible = String(guide.edge === hoveredEdge);
      }
      if (
        motion.current ||
        renderedAngle !== angleRef.current ||
        renderedYaw !== baseYaw ||
        camera.top !== halfHeight ||
        buttonsMoving
      )
        invalidate();
    };
    const videoCallbacks = new Map<HTMLVideoElement, number>();
    for (const video of [props.outer, props.inner]) {
      const frame = () => {
        if (disposed) return;
        invalidate();
        videoCallbacks.set(video, video.requestVideoFrameCallback(frame));
      };
      if ('requestVideoFrameCallback' in video)
        videoCallbacks.set(video, video.requestVideoFrameCallback(frame));
    }
    const fallback =
      !('requestVideoFrameCallback' in props.outer) ? window.setInterval(invalidate, 1000 / 30) : undefined;
    const intersection = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      invalidate();
    });
    intersection.observe(container);
    document.addEventListener('visibilitychange', invalidate);
    resize();
    return () => {
      disposed = true;
      invalidateFrame.current = () => undefined;
      intersection.disconnect();
      document.removeEventListener('visibilitychange', invalidate);
      for (const [video, id] of videoCallbacks) video.cancelVideoFrameCallback(id);
      clearInterval(fallback);
      up();
      buttons.release();
      cancelAnimationFrame(animation);
      observer.disconnect();
      window.removeEventListener('blur', blur);
      container.removeEventListener('pointerleave', leave);
      container.removeEventListener('pointerdown', down);
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', up);
      container.removeEventListener('pointercancel', up);
      container.removeEventListener('lostpointercapture', up);
      container.removeEventListener('keydown', keyDown);
      container.removeEventListener('keyup', keyUp);
      container.removeEventListener('focusin', focus);
      container.removeEventListener('focusout', focusOut);
      renderer.dispose();
      renderer.forceContextLoss();
      model.dispose();
      outerTexture.dispose();
      innerTexture.dispose();
      environmentMap.dispose();
      renderer.domElement.remove();
    };
  }, [props.outer, props.inner, props.modelUrl]);

  return (
    <div className="rc-duo">
      <div
        ref={host}
        className="rc-duo-stage"
        data-position-locked={positionLocked}
        tabIndex={0}
        role="application"
        aria-label="iPhone Duo simulator. Touch the screen to control iOS. Unlock position to rotate the view."
        onKeyDown={props.onKeyDown}
        onKeyUp={props.onKeyUp}
      >
        {(Object.keys(DUO_BUTTONS) as DuoButton[]).map((button) => (
          <button
            key={button}
            ref={(element) => {
              if (element) hardwareNodes.current.set(button, element);
              else hardwareNodes.current.delete(button);
            }}
            type="button"
            className="rc-duo-hardware"
            data-duo-button={button}
            data-visible="false"
            aria-label={DUO_BUTTONS[button]}
            title={DUO_BUTTONS[button]}
          >
            <DuoHardwareIcon button={button} />
          </button>
        ))}
      </div>
      <DuoControls
        angle={angle}
        onFold={fold}
        foldTarget={target}
        onHingeDrag={cancelFold}
        changeAngle={changeAngle}
        interacting={interacting}
        rotate={() => {
          void props
            .setOrientation(props.state.orientation === 'portrait' ? 'landscape-left' : 'portrait')
            .catch((reason) => setError(String(reason)));
        }}
      >
        {(['front', 'book', 'table', 'back'] as const).map((value) => (
          <button
            key={value}
            aria-pressed={view === value}
            onClick={() => {
              viewRevision.current++;
              setView(value);
              invalidateFrame.current();
              if (value === 'book') {
                void props
                  .setOrientation('portrait')
                  .then(() => changeAngle(110))
                  .catch((reason) => setError(String(reason)));
              }
              if (value === 'table') {
                void props
                  .setOrientation('landscape-left')
                  .then(() => changeAngle(110))
                  .catch((reason) => setError(String(reason)));
              }
            }}
          >
            {value === 'table' ? 'Laptop view' : value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
        <button
          className="rc-duo-lock"
          aria-label="Lock position"
          aria-pressed={positionLocked}
          title={
            positionLocked ?
              'Position is locked. Screen touches still control iOS.'
            : 'Drag the frame or background to rotate. Alt-drag rotates from the screen.'
          }
          onClick={() => setPositionLocked(!positionLocked)}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="4" y="9" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" />
            <path
              d={positionLocked ? 'M6 9V6a4 4 0 0 1 8 0v3' : 'M6 9V6a4 4 0 0 1 8 0'}
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          {positionLocked ? 'Position locked' : 'Lock position'}
        </button>
      </DuoControls>
      {error && (
        <div role="alert" className="rc-duo-error">
          {error}
        </div>
      )}
    </div>
  );
}
