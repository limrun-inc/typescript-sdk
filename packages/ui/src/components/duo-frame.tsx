import React, { useEffect, useId, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DUO_DIMENSIONS, HingeSender, panelTouch, type DuoState, type DuoOrientation } from '../core/duo';

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
  const viewRef = useRef(view);
  viewRef.current = view;
  const [orbit, setOrbit] = useState(false);
  const orbitRef = useRef(orbit);
  orbitRef.current = orbit;
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
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
    camera.position.set(0, 0, 340);
    const root = new THREE.Group();
    const device = new THREE.Group();
    const left = new THREE.Group();
    const right = new THREE.Group();
    device.add(left, right);
    root.add(device);
    scene.add(root);
    scene.add(new THREE.HemisphereLight(0xecf1ff, 0x33394b, 3));
    const key = new THREE.DirectionalLight(0xffffff, 4);
    key.position.set(-100, 180, 260);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc1d3ff, 3);
    rim.position.set(200, -40, -200);
    scene.add(rim);
    const metal = new THREE.MeshStandardMaterial({ color: 0x737b87, metalness: 0.75, roughness: 0.27 });
    const back = new THREE.MeshStandardMaterial({ color: 0x242936, metalness: 0.4, roughness: 0.38 });
    const black = new THREE.MeshStandardMaterial({ color: 0x080a0e, roughness: 0.2, metalness: 0.15 });
    const lens = new THREE.MeshStandardMaterial({ color: 0x101c33, metalness: 0.6, roughness: 0.08 });
    const { width, height, depth } = DUO_DIMENSIONS;
    const half = width / 2;
    const hitObjects: THREE.Object3D[] = [];
    const resources: Array<{ dispose(): void }> = [metal, back, black, lens];

    const box = (w: number, h: number, d: number, radius: number, material: THREE.Material) => {
      const geometry = new RoundedBoxGeometry(w, h, d, 4, radius);
      resources.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      hitObjects.push(mesh);
      return mesh;
    };
    const outline = (w: number, h: number, leftRadius: number, rightRadius: number) => {
      const shape = new THREE.Shape();
      const x = -w / 2,
        y = -h / 2;
      shape.moveTo(x + leftRadius, y);
      shape.lineTo(x + w - rightRadius, y);
      shape.quadraticCurveTo(x + w, y, x + w, y + rightRadius);
      shape.lineTo(x + w, y + h - rightRadius);
      shape.quadraticCurveTo(x + w, y + h, x + w - rightRadius, y + h);
      shape.lineTo(x + leftRadius, y + h);
      shape.quadraticCurveTo(x, y + h, x, y + h - leftRadius);
      shape.lineTo(x, y + leftRadius);
      shape.quadraticCurveTo(x, y, x + leftRadius, y);
      return shape;
    };
    const plate = (w: number, h: number, d: number, lr: number, rr: number, material: THREE.Material) => {
      const geometry = new THREE.ExtrudeGeometry(outline(w, h, lr, rr), {
        depth: d,
        bevelEnabled: true,
        bevelSize: 0.18,
        bevelThickness: 0.15,
        bevelSegments: 2,
        steps: 1,
        curveSegments: 16,
      });
      resources.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      hitObjects.push(mesh);
      return mesh;
    };
    for (const [part, side] of [
      [left, -1],
      [right, 1],
    ] as const) {
      const lr = side === -1 ? 8 : 0.6,
        rr = side === 1 ? 8 : 0.6;
      const body = plate(half - 0.3, height, depth - 0.3, lr, rr, metal);
      body.position.set((side * half) / 2, 0, -depth + 0.15);
      part.add(body);
      const rear = plate(half - 1.2, height - 1.2, 0.12, lr, rr, back);
      rear.position.set((side * half) / 2, 0, -depth - 0.15);
      part.add(rear);
      const seal = plate(half - 0.4, height - 0.8, 0.12, lr, rr, black);
      seal.position.set((side * half) / 2, 0, 0);
      part.add(seal);
    }
    const outerTexture = new THREE.VideoTexture(props.outer);
    const innerTexture = new THREE.VideoTexture(props.inner);
    for (const texture of [outerTexture, innerTexture]) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      resources.push(texture);
    }

    const screen = (
      part: THREE.Group,
      x: number,
      w: number,
      h: number,
      texture: THREE.Texture,
      display: 'inner' | 'outer',
      side = 0,
    ) => {
      const shape = outline(
        w,
        h,
        display === 'inner' && side === 1 ? 0 : 6.4,
        display === 'inner' && side === 0 ? 0 : 6.4,
      );
      const geometry = new THREE.ShapeGeometry(shape, 20);
      const positions = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      for (let index = 0; index < positions.count; index++) {
        const u = (positions.getX(index) + w / 2) / w;
        const v = (positions.getY(index) + h / 2) / h;
        // The inner panel's physical landscape axis is rotated from its native portrait buffer.
        if (display === 'inner') uv.setXY(index, 1 - v, (u + side) / 2);
        else uv.setXY(index, u, v);
      }
      const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
      resources.push(geometry, material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, 0, display === 'inner' ? 0.3 : -depth - 0.4);
      if (display === 'outer') mesh.rotation.y = Math.PI;
      mesh.userData['display'] = display;
      hitObjects.push(mesh);
      part.add(mesh);
    };
    screen(left, -(half - 2.1) / 2, half - 2.1, height - 4.2, innerTexture, 'inner', 0);
    screen(right, (half - 2.1) / 2, half - 2.1, height - 4.2, innerTexture, 'inner', 1);
    screen(left, -half / 2, half - 3.4, height - 4.2, outerTexture, 'outer');

    // Camera glass is on the rear half; the inner camera sits under the display.
    const cameraIsland = box(half - 10, 22, 2.1, 1, black);
    cameraIsland.position.set(half / 2, height / 2 - 16, -depth - 1.2);
    right.add(cameraIsland);
    for (const x of [half / 2 - 15, half / 2 + 7]) {
      const geometry = new THREE.CylinderGeometry(8.1, 8.1, 2.4, 40);
      resources.push(geometry);
      const cameraRing = new THREE.Mesh(geometry, metal);
      cameraRing.rotation.x = Math.PI / 2;
      cameraRing.position.set(x, height / 2 - 16, -depth - 2.7);
      right.add(cameraRing);
      const glassGeometry = new THREE.CircleGeometry(6.4, 40);
      resources.push(glassGeometry);
      const glass = new THREE.Mesh(glassGeometry, lens);
      glass.rotation.y = Math.PI;
      glass.position.set(x, height / 2 - 16, -depth - 4);
      right.add(glass);
    }
    const hingeGeometry = new THREE.CylinderGeometry(2.5, 2.5, height - 12, 24);
    resources.push(hingeGeometry);
    const hinge = new THREE.Mesh(hingeGeometry, metal);
    hinge.position.z = -2.5;
    left.add(hinge);
    for (const y of [18, 35]) {
      const button = box(1.2, y === 18 ? 12 : 8, 2.1, 0.4, metal);
      button.position.set(half, y, -depth / 2);
      right.add(button);
    }

    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let drag:
      | { pointer: number; screenId?: number; x: number; y: number; clientX: number; clientY: number }
      | undefined;
    let yaw = 0,
      pitch = 0;
    let previousView = viewRef.current;
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
      const hit = orbitRef.current || event.altKey ? undefined : pick(event);
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
      } else {
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
      if (viewRef.current !== previousView) {
        yaw = 0;
        pitch = 0;
        previousView = viewRef.current;
      }
      renderedAngle = THREE.MathUtils.damp(renderedAngle, angleRef.current, 18, dt);
      right.rotation.y = (-(180 - renderedAngle) * Math.PI) / 180;
      // Closed view presents the cover. Intermediate poses retain perspective and true occlusion.
      const closed = 1 - THREE.MathUtils.smoothstep(renderedAngle, 15, 110);
      const baseYaw = closed * Math.PI + (viewRef.current === 'back' ? Math.PI : 0);
      renderedYaw = THREE.MathUtils.damp(renderedYaw, baseYaw, 12, dt);
      // Camera orbit stays independent of the native device orientation.
      root.rotation.set(
        pitch +
          (viewRef.current === 'table' ? -0.8
          : viewRef.current === 'book' ? 0.12
          : 0),
        yaw,
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
      resources.forEach((resource) => resource.dispose());
      renderer.domElement.remove();
    };
  }, [props.outer, props.inner]);

  return (
    <div className="rc-duo">
      <div
        ref={host}
        className="rc-duo-stage"
        tabIndex={0}
        role="application"
        aria-label="iPhone Duo simulator. Drag the screen to touch; use Rotate view to turn the device."
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
                setView(value);
                if (value === 'book') {
                  changeAngle(110);
                  void props.setOrientation('portrait').catch((reason) => setError(String(reason)));
                }
                if (value === 'table') {
                  changeAngle(110);
                  void props.setOrientation('landscape-left').catch((reason) => setError(String(reason)));
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
          <button aria-pressed={orbit} onClick={() => setOrbit(!orbit)}>
            Rotate view
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
