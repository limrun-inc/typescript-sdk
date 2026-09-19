import React, { useEffect, useId, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createDuoModel } from './duo-model';
import { HingeSender, panelTouch, duoPointerMode, type DuoState, type DuoOrientation } from '../core/duo';

interface Props {
  outer: HTMLVideoElement | null;
  inner: HTMLVideoElement | null;
  state: DuoState;
  setAngle: (degrees: number) => Promise<void>;
  setOrientation: (orientation: DuoOrientation) => Promise<void>;
  touch: (action: number, screenId: number, x: number, y: number) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  onKeyUp: React.KeyboardEventHandler<HTMLDivElement>;
}

type View = 'front' | 'book' | 'table' | 'back';

/** A procedural titanium frame. Each glass panel carries its own native video texture. */
export default function DuoFrame(props: Props) {
  const angleId = useId();
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [angle, setAngle] = useState(props.state.angleDegrees);
  const angleRef = useRef(angle);
  angleRef.current = angle;
  const [view, setView] = useState<View>('front');
  const viewRevision = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [positionLocked, setPositionLocked] = useState(true);
  const lockedRef = useRef(positionLocked);
  lockedRef.current = positionLocked;
  const [error, setError] = useState<string>();
  const sender = useRef<HingeSender | null>(null);
  const interacting = useRef(false);
  const pendingAngle = useRef<number | undefined>(undefined);

  useEffect(() => {
    sender.current = new HingeSender(
      async (degrees) => {
        await latest.current.setAngle(degrees);
        if (pendingAngle.current === degrees) pendingAngle.current = undefined;
      },
      (reason) => {
        setError(String(reason));
        pendingAngle.current = undefined;
        setAngle(latest.current.state.angleDegrees);
      },
    );
    return () => {
      sender.current?.stop();
      sender.current = null;
    };
  }, []);

  useEffect(() => {
    if (!interacting.current && pendingAngle.current === undefined) setAngle(props.state.angleDegrees);
  }, [props.state.angleDegrees]);

  const changeAngle = (degrees: number) => {
    setError(undefined);
    pendingAngle.current = degrees;
    setAngle(degrees);
    sender.current?.set(degrees);
  };

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
    camera.position.set(0, 0, 340);
    const root = new THREE.Group();
    const environment = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environmentMap = pmrem.fromScene(environment, 0.04);
    scene.environment = environmentMap.texture;
    scene.environmentIntensity = 1.25;
    environment.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9ba3af, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-100, 180, 260);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xe4edff, 1.3);
    rim.position.set(200, -40, -200);
    scene.add(rim);
    const outerTexture = new THREE.VideoTexture(props.outer);
    const innerTexture = new THREE.VideoTexture(props.inner);
    for (const texture of [outerTexture, innerTexture]) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
    }

    const model = createDuoModel(outerTexture, innerTexture);
    const { device, hitObjects } = model;
    root.add(device);
    scene.add(root);

    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let drag:
      | { pointer: number; screenId?: number; x: number; y: number; clientX: number; clientY: number }
      | undefined;
    let yaw = 0,
      pitch = 0;
    let previousViewRevision = viewRevision.current;
    let renderedAngle = angleRef.current;
    let renderedYaw = 0;
    let animation = 0;
    let lastTime = 0;
    const pick = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      );
      ray.setFromCamera(pointer, camera);
      const intersection = ray.intersectObjects(hitObjects, false)[0];
      if (!intersection?.uv || !intersection.object.userData['display']) return undefined;
      const display = latest.current.state.displays.find(
        (d) => d.id === intersection.object.userData['display'],
      );
      if (!display) return undefined;
      return { screenId: display.screenId, ...panelTouch(intersection.uv.x, intersection.uv.y) };
    };
    const down = (event: PointerEvent) => {
      if (drag || event.button !== 0) return;
      container.focus({ preventScroll: true });
      const picked = pick(event);
      const mode = duoPointerMode(lockedRef.current, !!picked, event.altKey);
      if (mode === 'ignore') return;
      const hit = mode === 'touch' ? picked : undefined;
      drag = {
        pointer: event.pointerId,
        ...hit,
        x: hit?.x ?? 0,
        y: hit?.y ?? 0,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      renderer.domElement.setPointerCapture(event.pointerId);
      if (hit) latest.current.touch(0, hit.screenId, hit.x, hit.y);
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      if (drag.screenId) {
        const hit = pick(event);
        if (hit && hit.screenId === drag.screenId) {
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
      if (!drag || (event && drag.pointer !== event.pointerId)) return;
      if (drag.screenId) latest.current.touch(1, drag.screenId, drag.x, drag.y);
      drag = undefined;
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('pointerup', up);
    renderer.domElement.addEventListener('pointercancel', up);
    renderer.domElement.addEventListener('lostpointercapture', up);
    const blur = () => up();
    window.addEventListener('blur', blur);
    const resize = () => {
      const w = container.clientWidth,
        h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;

      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const bounds = new THREE.Box3();
    const center = new THREE.Vector3();
    const extent = new THREE.Vector3();
    const animate = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      if (viewRevision.current !== previousViewRevision) {
        yaw = 0;
        pitch = 0;
        previousViewRevision = viewRevision.current;
      }
      renderedAngle = THREE.MathUtils.damp(renderedAngle, angleRef.current, 18, dt);
      model.setAngle(renderedAngle);
      // Closed view presents the cover. Intermediate poses retain perspective and true occlusion.
      const closed = 1 - THREE.MathUtils.smoothstep(renderedAngle, 15, 110);
      const baseYaw = (closed * Math.PI) / 2 + (viewRef.current === 'back' ? Math.PI : 0);
      renderedYaw = THREE.MathUtils.damp(renderedYaw, baseYaw, 12, dt);
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
      bounds.setFromObject(root).getCenter(center);
      bounds.getSize(extent);
      root.position.copy(center).negate();
      const tangent = Math.tan((camera.fov * Math.PI) / 360);
      const distance =
        Math.max(extent.y / (2 * tangent * 0.8), extent.x / (2 * tangent * camera.aspect * 0.85)) +
        extent.z / 2;
      camera.position.z = THREE.MathUtils.damp(camera.position.z, distance, 14, dt);

      renderer.render(scene, camera);
      animation = requestAnimationFrame(animate);
    };
    animation = requestAnimationFrame(animate);
    return () => {
      up();
      cancelAnimationFrame(animation);
      observer.disconnect();
      window.removeEventListener('blur', blur);
      renderer.dispose();
      model.dispose();
      outerTexture.dispose();
      innerTexture.dispose();
      environmentMap.dispose();
      renderer.domElement.remove();
    };
  }, [props.outer, props.inner]);

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
      />
      <div className="rc-duo-controls" onPointerDown={(event) => event.stopPropagation()}>
        <div className="rc-duo-hinge">
          <button onClick={() => changeAngle(angle < 90 ? 180 : 0)}>{angle < 90 ? 'Unfold' : 'Fold'}</button>
          <label htmlFor={angleId}>Hinge</label>
          <input
            id={angleId}
            type="range"
            min={0}
            max={180}
            step={1}
            value={angle}
            onPointerDown={() => {
              interacting.current = true;
            }}
            onPointerUp={() => {
              interacting.current = false;
            }}
            onPointerCancel={() => {
              interacting.current = false;
            }}
            onChange={(event) => changeAngle(Number(event.target.value))}
          />
          <output>{Math.round(angle)}°</output>
        </div>
        <div className="rc-duo-views" aria-label="Device view">
          {(['front', 'book', 'table', 'back'] as const).map((value) => (
            <button
              key={value}
              aria-pressed={view === value}
              onClick={() => {
                viewRevision.current++;
                setView(value);
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
            onClick={() => {
              const next = props.state.orientation === 'portrait' ? 'landscape-left' : 'portrait';
              void props.setOrientation(next).catch((reason) => setError(String(reason)));
            }}
          >
            Rotate device
          </button>
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
