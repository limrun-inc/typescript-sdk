import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DUO_DIMENSIONS } from '../core/duo';

// Body dimensions are published by Apple; radii and hardware details follow its product photographs.
const { width, height, depth } = DUO_DIMENSIONS;
const half = width / 2;
const pivot = (11.3 - depth * 2) / 2;
const innerWidth = 157.5;
const innerHeight = 110.8;
const bendWidth = 1.1;
const glassZ = 0.14;

function outline(w: number, h: number, lr: number, rr: number) {
  const shape = new THREE.Shape();
  const x = -w / 2,
    y = -h / 2;
  // Circular quarter-arcs retain the generous outside corners and tight hinge corners.
  shape.moveTo(x + lr, y);
  shape.lineTo(x + w - rr, y);
  if (rr) shape.absarc(x + w - rr, y + rr, rr, -Math.PI / 2, 0, false);
  shape.lineTo(x + w, y + h - rr);
  if (rr) shape.absarc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2, false);
  shape.lineTo(x + lr, y + h);
  if (lr) shape.absarc(x + lr, y + h - lr, lr, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + lr);
  if (lr) shape.absarc(x + lr, y + lr, lr, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** Independent of WebGL so fold geometry and touch occlusion can be tested directly. */
export function createDuoModel(
  outerTexture: THREE.Texture,
  innerTexture: THREE.Texture,
  environment?: THREE.Texture,
) {
  const device = new THREE.Group();
  const left = new THREE.Group();
  const right = new THREE.Group();
  device.add(left, right);
  const hitObjects: THREE.Object3D[] = [];
  const resources: Array<{ dispose(): void }> = [];
  const metal = new THREE.MeshPhysicalMaterial({
    color: 0xbec1c3,
    metalness: 1,
    roughness: 0.19,
    clearcoat: 0.5,
  });
  const ceramic = new THREE.MeshPhysicalMaterial({
    color: 0xe3e2dc,
    metalness: 0.04,
    roughness: 0.3,
    clearcoat: 0.65,
    clearcoatRoughness: 0.18,
  });
  const hingeMetal = new THREE.MeshStandardMaterial({ color: 0xa7a9a8, metalness: 0.85, roughness: 0.36 });
  const gasket = new THREE.MeshBasicMaterial({ color: 0x080a0c });
  const antenna = new THREE.MeshStandardMaterial({ color: 0xa4a5a0, roughness: 0.55 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x03060d,
    envMap: environment,
    envMapIntensity: 0.05,
    metalness: 1,
    roughness: 0.22,
  });
  const optic = new THREE.MeshPhysicalMaterial({
    color: 0x102137,
    envMap: environment,
    envMapIntensity: 0.04,
    metalness: 1,
    roughness: 0.3,
  });
  const flash = new THREE.MeshStandardMaterial({ color: 0xefead4, roughness: 0.35 });
  const logo = new THREE.MeshStandardMaterial({
    color: 0xc0c0bc,
    metalness: 0.6,
    roughness: 0.25,
    side: THREE.DoubleSide,
  });
  const outerMaterial = new THREE.MeshBasicMaterial({ map: outerTexture, toneMapped: false });
  const innerMaterial = new THREE.MeshBasicMaterial({ map: innerTexture, toneMapped: false });
  resources.push(
    metal,
    ceramic,
    hingeMetal,
    gasket,
    antenna,
    glass,
    optic,
    flash,
    logo,
    outerMaterial,
    innerMaterial,
  );
  const mesh = <T extends THREE.BufferGeometry>(geometry: T, material: THREE.Material) => {
    resources.push(geometry);
    const result = new THREE.Mesh(geometry, material);
    hitObjects.push(result);
    return result;
  };
  const plate = (
    w: number,
    h: number,
    d: number,
    lr: number,
    rr: number,
    material: THREE.Material,
    bevel = 0.12,
  ) =>
    mesh(
      new THREE.ExtrudeGeometry(outline(w, h, lr, rr), {
        depth: d,
        bevelEnabled: bevel > 0,
        bevelSize: bevel,
        bevelThickness: bevel,
        bevelSegments: 3,
        steps: 1,
        curveSegments: 20,
      }),
      material,
    );
  const box = (w: number, h: number, d: number, radius: number, material: THREE.Material) =>
    mesh(new RoundedBoxGeometry(w, h, d, 3, radius), material);

  for (const [part, side] of [
    [left, -1],
    [right, 1],
  ] as const) {
    const lr = side === -1 ? 8.6 : 0.55;
    const rr = side === 1 ? 8.6 : 0.55;
    const rail = plate(half - 0.3, height - 0.3, depth - 0.5, lr, rr, metal, 0.2);
    rail.position.set((side * half) / 2, 0, -depth + 0.25);
    part.add(rail);
    const rear = plate(half - 1.25, height - 1.25, 0.2, lr - 0.3, rr - 0.3, ceramic);
    rear.position.set((side * half) / 2, 0, -depth - 0.02);
    part.add(rear);
    const seal = plate(half - 0.8, height - 0.8, 0.1, lr - 0.2, rr - 0.2, gasket, 0.05);
    seal.position.set((side * half) / 2, 0, -0.06);
    part.add(seal);
    // Antenna bands interrupt the polished side rails near each corner.
    for (const y of [-height / 2 + 13, height / 2 - 13]) {
      const band = box(0.22, 0.65, depth - 0.8, 0.08, antenna);
      band.position.set(side * (half + 0.04), y, -depth / 2);
      part.add(band);
    }
    // Speaker perforations follow the top and bottom rails, clear of the hinge.
    for (const edge of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const hole = mesh(new THREE.CircleGeometry(0.36, 10), gasket);
        hole.rotation.x = (-edge * Math.PI) / 2;
        hole.position.set(side * (half - 19 - i * 1.7), edge * (height / 2 + 0.06), -depth / 2);
        part.add(hole);
      }
    }
  }

  const screen = (
    part: THREE.Group,
    x: number,
    w: number,
    h: number,
    display: 'inner' | 'outer',
    side = 0,
  ) => {
    const shape =
      display === 'outer' ?
        outline(w, h, 0.8, 6.6)
      : outline(w, h, side === 0 ? 5.3 : 0, side === 1 ? 5.3 : 0);
    const geometry = new THREE.ShapeGeometry(shape, 24);
    const positions = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < positions.count; i++) {
      const u = (positions.getX(i) + w / 2) / w;
      const v = (positions.getY(i) + h / 2) / h;
      if (display === 'inner') {
        const physicalX = positions.getX(i) + x;
        uv.setXY(i, 1 - v, (physicalX + innerWidth / 2) / innerWidth);
      } else uv.setXY(i, u, v);
    }
    const panel = mesh(geometry, display === 'inner' ? innerMaterial : outerMaterial);
    panel.name = display === 'outer' ? 'cover-display' : `inner-display-${side}`;
    panel.position.set(x, 0, display === 'inner' ? glassZ : -depth - 0.25);
    if (display === 'outer') panel.rotation.y = Math.PI;
    panel.userData['display'] = display;
    part.add(panel);
  };
  const innerHalf = innerWidth / 2 - bendWidth;
  screen(left, -(innerWidth / 2 + bendWidth) / 2, innerHalf, innerHeight, 'inner', 0);
  screen(right, (innerWidth / 2 + bendWidth) / 2, innerHalf, innerHeight, 'inner', 1);
  // The cover's hinge edge is nearly square; the exposed edge follows the rounded titanium rail.
  const coverSeal = plate(half - 0.85, height - 0.9, 0.08, 8.1, 0.3, gasket, 0.04);
  coverSeal.position.set(-half / 2, 0, -depth - 0.15);
  left.add(coverSeal);
  screen(left, -half / 2, 77.1, 112.2, 'outer');

  // A compact ceramic capsule carries two independently raised, concentric camera rings.
  const cameraY = height / 2 - 15;
  const island = plate(57, 20, 1.6, 10, 10, ceramic, 0.28);
  island.position.set(half / 2 + 2, cameraY, -depth - 1.8);
  right.add(island);
  const disc = (radius: number, material: THREE.Material, x: number, y: number, z: number) => {
    const result = mesh(new THREE.CircleGeometry(radius, 48), material);
    result.rotation.y = Math.PI;
    result.position.set(x, y, z);
    right.add(result);
    return result;
  };
  for (const x of [half / 2 + 19, half / 2 - 1]) {
    const ring = mesh(new THREE.CylinderGeometry(8.05, 8.05, 1.7, 64), metal);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, cameraY, -depth - 2.55);
    right.add(ring);
    disc(7.35, gasket, x, cameraY, -depth - 3.43);
    disc(6.65, glass, x, cameraY, -depth - 3.46);
    disc(2.5, optic, x, cameraY, -depth - 3.48);
    disc(1.9, glass, x, cameraY, -depth - 3.5);
    const reflection = disc(0.7, optic, x - 1.1, cameraY + 1.15, -depth - 3.52);
    reflection.scale.y = 0.55;
  }
  disc(2.2, metal, half / 2 - 18, cameraY - 3, -depth - 2.11);
  disc(1.8, flash, half / 2 - 18, cameraY - 3, -depth - 2.15);
  disc(0.65, gasket, half / 2 - 18, cameraY + 3.2, -depth - 2.15);

  // A subdued inlay sits beneath the ceramic surface, as on the rear product photographs.
  const apple = new THREE.Shape();
  apple.moveTo(0, 3.2);
  apple.bezierCurveTo(-1.5, 4.2, -3.5, 4.3, -4.8, 2.6);
  apple.bezierCurveTo(-6.4, 0.3, -4.4, -4.6, -2.5, -5.4);
  apple.bezierCurveTo(-1.4, -5.9, -0.8, -5, 0, -5);
  apple.bezierCurveTo(1, -5, 1.7, -5.9, 2.8, -5.3);
  apple.bezierCurveTo(3.8, -4.5, 4.6, -3.1, 4.9, -2.1);
  apple.bezierCurveTo(2.3, -1.2, 2.1, 1.5, 4.1, 2.8);
  apple.bezierCurveTo(3, 4.3, 1.5, 4, 0, 3.2);
  const leaf = new THREE.Shape();
  leaf.moveTo(-0.2, 4);
  leaf.bezierCurveTo(-0.3, 5.7, 1, 6.9, 2.5, 7.1);
  leaf.bezierCurveTo(2.6, 5.6, 1.2, 4, -0.2, 4);
  const inlay = mesh(new THREE.ShapeGeometry([apple, leaf], 20), logo);
  inlay.rotation.y = Math.PI;
  inlay.position.set(half / 2, -3, -depth - 0.16);
  right.add(inlay);

  for (const [y, length] of [
    [21, 13],
    [-12, 12],
  ] as const) {
    const button = box(0.7, length, 2.5, 0.28, y > 0 ? metal : antenna);
    button.position.set(half + 0.15, y, -depth / 2);
    right.add(button);
  }
  for (const x of [half - 25, half - 37]) {
    const volume = box(9.5, 0.65, 2.1, 0.27, metal);
    volume.position.set(x, height / 2 + 0.12, -depth / 2);
    right.add(volume);
  }
  const port = plate(8.2, 2.25, 0.05, 1.12, 1.12, gasket, 0);
  port.rotation.x = Math.PI / 2;
  port.position.set(half / 2, -height / 2 - 0.07, -depth / 2);
  right.add(port);

  const segments = 24;
  const strip = (material: THREE.Material, display = false) => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array((segments + 1) * 2 * 3);
    const uv = new Float32Array((segments + 1) * 2 * 2);
    const indices: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const v = (innerWidth / 2 - bendWidth + (2 * bendWidth * i) / segments) / innerWidth;
      uv.set([1, v, 0, v], i * 4);
      if (i < segments) {
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
    }
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    const result = mesh(geometry, material);
    if (display) result.userData['display'] = 'inner';
    device.add(result);
    return geometry;
  };
  const bendSeal = strip(gasket);
  const bend = strip(innerMaterial, true);
  const spine = strip(hingeMetal);
  spine.setIndex(Array.from(spine.getIndex()!.array).reverse());

  const setAngle = (degrees: number) => {
    const radians = THREE.MathUtils.degToRad((180 - degrees) / 2);
    const s = Math.sin(radians),
      c = Math.cos(radians);
    for (const [part, sign] of [
      [left, 1],
      [right, -1],
    ] as const) {
      part.rotation.y = sign * radians;
      part.position.set(-sign * pivot * s, 0, pivot * (1 - c));
    }
    const endX = bendWidth * c + (pivot - glassZ) * s;
    const endZ = bendWidth * s + glassZ * c + pivot * (1 - c);
    const handle = (2 * bendWidth) / 3;
    const backX = 0.45 * c + (depth + pivot) * s;
    const backZ = 0.45 * s - depth * c + pivot * (1 - c);
    const spineZ = -depth * (1 - s) - 1.8 * s;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments,
        a = 1 - t;
      const x =
        a * a * a * -endX +
        3 * a * a * t * (-endX + c * handle) +
        3 * a * t * t * (endX - c * handle) +
        t * t * t * endX;
      const z = endZ - 3 * a * t * s * handle;
      const edge = Math.PI * t;
      for (let row = 0; row < 2; row++) {
        bend.getAttribute('position').setXYZ(i * 2 + row, x, (row - 0.5) * innerHeight, z);
        bendSeal.getAttribute('position').setXYZ(i * 2 + row, x, (row - 0.5) * (height - 0.9), z - 0.07);
        spine
          .getAttribute('position')
          .setXYZ(
            i * 2 + row,
            -backX * Math.cos(edge),
            (row - 0.5) * (height - 0.9),
            backZ + (spineZ - backZ) * Math.sin(edge),
          );
      }
    }
    for (const geometry of [bendSeal, bend, spine]) {
      geometry.getAttribute('position').needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
    }
    device.updateMatrixWorld(true);
  };
  setAngle(180);
  return { device, hitObjects, setAngle, dispose: () => resources.forEach((resource) => resource.dispose()) };
}
