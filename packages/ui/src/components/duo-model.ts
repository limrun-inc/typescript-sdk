import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DUO_DIMENSIONS, type DuoButton } from '../core/duo';

// Body dimensions are published by Apple; radii and hardware details follow its product photographs.
const { width, height, depth } = DUO_DIMENSIONS;
const half = width / 2;
const pivot = (11.3 - depth * 2) / 2;
const innerWidth = 157.5;
const innerHeight = 110.8;
const bendWidth = 1.1;
const glassZ = 0.14;

// Nearby studio lights vary across a rail even with the parallel camera used for simulator input.
function polishSilver(material: THREE.MeshStandardMaterial, environment?: THREE.Texture) {
  material.envMap = environment ?? null;
  material.envMapIntensity = 1;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying vec3 vDuoStudioPosition;\n${shader.vertexShader}`.replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvDuoStudioPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
    shader.fragmentShader = `
      varying vec3 vDuoStudioPosition;
      vec3 duoStudioReflection(vec3 direction) {
        float radius = 240.0;
        float along = dot(vDuoStudioPosition, direction);
        float distance = -along + sqrt(max(0.0, along * along + radius * radius - dot(vDuoStudioPosition, vDuoStudioPosition)));
        return normalize(vDuoStudioPosition + direction * distance);
      }
    ${shader.fragmentShader}`.replace(
      '#include <envmap_physical_pars_fragment>',
      THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
        'envMapRotation * reflectVec',
        'envMapRotation * duoStudioReflection(reflectVec)',
      ),
    );
  };
  material.customProgramCacheKey = () => 'duo-polished-silver-v1';
}

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
  const buttons = new Map<DuoButton, THREE.Object3D>();
  const buttonBases = new Map<DuoButton, THREE.Vector3>();
  const buttonOffsets = new Map<DuoButton, number>();
  let hoveredButton: DuoButton | undefined;
  let pressedButton = false;
  let disposed = false;
  const buttonTargets: THREE.Object3D[] = [];
  const resources: Array<{ dispose(): void }> = [];
  const metal = new THREE.MeshPhysicalMaterial({
    color: 0xe8ebee,
    metalness: 1,
    roughness: 0.055,
    clearcoat: 1,
    clearcoatRoughness: 0.055,
    envMapIntensity: 1.15,
  });
  const ceramic = new THREE.MeshPhysicalMaterial({
    color: 0xf3f1eb,
    metalness: 0.04,
    roughness: 0.2,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  const hingeMetal = metal.clone();
  hingeMetal.roughness = 0.085;
  polishSilver(metal, environment);
  polishSilver(hingeMetal, environment);
  const gasket = new THREE.MeshBasicMaterial({ color: 0x080a0c });
  const antenna = new THREE.MeshStandardMaterial({ color: 0xa4a5a0, roughness: 0.55 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x03060d,
    envMap: environment ?? null,
    envMapIntensity: 0.05,
    metalness: 1,
    roughness: 0.22,
  });
  const optic = new THREE.MeshPhysicalMaterial({
    color: 0x102137,
    envMap: environment ?? null,
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
      toCreasedNormals(
        new THREE.ExtrudeGeometry(outline(w, h, lr, rr), {
          depth: d,
          bevelEnabled: bevel > 0,
          bevelSize: bevel,
          bevelThickness: bevel,
          bevelSegments: 3,
          steps: 1,
          curveSegments: 20,
        }),
        Math.PI / 3,
      ),
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
    const rail = plate(half - 0.3, height - 0.3, depth - 0.8, lr, rr, metal, 0.35);
    rail.position.set((side * half) / 2, 0, -depth + 0.4);
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

  const addButton = (name: DuoButton, w: number, h: number, x: number, y: number) => {
    const material = metal.clone();
    resources.push(material);
    const button = box(w, h, 2.5, 0.27, material);
    button.name = `button-${name}`;
    button.userData['button'] = name;
    button.position.set(x, y, -depth / 2);
    right.add(button);
    buttons.set(name, button);
    buttonBases.set(name, button.position.clone());
    // Extend away from the bezel so narrow hardware remains clickable without covering the glass.
    const target = box(w < h ? 4.5 : w, w < h ? h : 4.5, depth, 0.1, material);
    hitObjects.splice(hitObjects.indexOf(target), 1);
    target.position.set(x + (w < h ? 2 : 0), y + (w < h ? 0 : 2), -depth / 2);
    target.userData['button'] = name;
    target.visible = false;
    target.updateMatrix();
    buttonTargets.push(target);
  };
  addButton('side', 0.7, 13, half + 0.15, 21);
  addButton('volumeUp', 9.5, 0.65, half - 25, height / 2 + 0.12);
  addButton('volumeDown', 9.5, 0.65, half - 37, height / 2 + 0.12);
  const antennaWindow = box(0.35, 12, 2.5, 0.15, antenna);
  antennaWindow.position.set(half - 0.08, -12, -depth / 2);
  right.add(antennaWindow);
  const segments = 32;
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
  const hingeCaps = [-1, 1].map((edge) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array((segments + 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage),
    );
    const indices: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      indices.push(
        ...(edge === 1 ? [a, a + 1, a + 2, a + 1, a + 3, a + 2] : [a, a + 2, a + 1, a + 1, a + 2, a + 3]),
      );
    }
    geometry.setIndex(indices);
    const cap = mesh(geometry, hingeMetal);
    cap.name = `hinge-cap-${edge}`;
    device.add(cap);
    return { geometry, edge };
  });
  spine.setIndex(Array.from(spine.getIndex()!.array).reverse());

  let previousAngle: number | undefined;
  const setAngle = (degrees: number) => {
    if (previousAngle === degrees) return;
    previousAngle = degrees;
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
    const spineZ = -depth * (1 - s) - 0.8 * s;
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
      // Close the hinge ends between the flexible display seal and the titanium spine.
      for (const { geometry, edge: capEdge } of hingeCaps) {
        const positions = geometry.getAttribute('position');
        positions.setXYZ(i * 2, x, capEdge * (height / 2 - 0.45), z - 0.07);
        positions.setXYZ(
          i * 2 + 1,
          -backX * Math.cos(edge),
          capEdge * (height / 2 - 0.45),
          backZ + (spineZ - backZ) * Math.sin(edge),
        );
      }
    }
    for (const geometry of [bendSeal, bend, spine, ...hingeCaps.map((cap) => cap.geometry)]) {
      geometry.getAttribute('position').needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
    }
    device.updateMatrixWorld(true);
  };
  setAngle(180);
  return {
    device,
    hitObjects,
    setAngle,
    buttonAnchors: () =>
      [...buttonBases].map(([button, base]) => ({
        button,
        point: base.clone().applyMatrix4(right.matrixWorld),
        outward: base
          .clone()
          .add(button === 'side' ? new THREE.Vector3(10, 0, 0) : new THREE.Vector3(0, 10, 0))
          .applyMatrix4(right.matrixWorld),
      })),
    getBounds: (bounds: THREE.Box3) => {
      bounds.makeEmpty();
      const objectBounds = new THREE.Box3();
      for (const object of hitObjects) {
        if (!(object instanceof THREE.Mesh) || object.userData['button']) continue;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        objectBounds.copy(object.geometry.boundingBox!).applyMatrix4(object.matrixWorld);
        bounds.union(objectBounds);
      }
      return bounds;
    },
    pick: (ray: THREE.Raycaster) => {
      const surface = ray.intersectObjects(hitObjects, false)[0];
      if (surface?.object.userData['display'] || surface?.object.userData['button']) return surface;
      for (const target of buttonTargets)
        target.matrixWorld.multiplyMatrices(right.matrixWorld, target.matrix);
      const hardware = ray.intersectObjects(buttonTargets, false)[0];
      return hardware && (!surface || hardware.distance <= surface.distance) ? hardware : surface;
    },
    // Imported appearances replace the rigid body while live screens and the hinge remain under our control.
    loadAppearance: async (url: string) => {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { scene } = await new GLTFLoader().loadAsync(url);
      const importedResources = new Set<{ dispose(): void }>();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        importedResources.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          importedResources.add(material);
          if (
            material instanceof THREE.MeshStandardMaterial &&
            material.userData['finish'] === 'polished-silver'
          )
            polishSilver(material, environment);
          for (const value of Object.values(material))
            if (value instanceof THREE.Texture && value !== environment) importedResources.add(value);
        }
      });
      if (disposed) {
        importedResources.forEach((r) => r.dispose());
        return;
      }
      const coverBody = scene.getObjectByName('folding-half');
      const cameraBody = scene.getObjectByName('stationary-half');
      const importedButtons = new Set<DuoButton>();
      cameraBody?.traverse((object) => {
        if (object instanceof THREE.Mesh && object.userData['button'])
          importedButtons.add(object.userData['button']);
      });
      if (
        !coverBody ||
        !cameraBody ||
        !['side', 'volumeUp', 'volumeDown'].every((name) => importedButtons.has(name as DuoButton))
      ) {
        importedResources.forEach((r) => r.dispose());
        throw new Error(
          'Duo appearance requires both body halves and side, volumeUp, and volumeDown button meshes.',
        );
      }
      resources.push(...importedResources);
      // Match the imported cover aperture exactly so the live image cannot expose seams beneath its bezel.
      const cover = coverBody.children.find(
        (child) =>
          child instanceof THREE.Mesh &&
          (child.userData['sourceDisplay'] === 'outer' || child.material.name === 'cover-screen'),
      ) as THREE.Mesh | undefined;
      if (cover) {
        const panel = device.getObjectByName('cover-display') as THREE.Mesh;
        const geometry = cover.geometry.clone().scale(10, 10, 10);
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox!;
        const positions = geometry.getAttribute('position');
        const uv = new THREE.BufferAttribute(new Float32Array(positions.count * 2), 2);
        for (let i = 0; i < positions.count; i++) {
          uv.setXY(
            i,
            (bounds.max.x - positions.getX(i)) / (bounds.max.x - bounds.min.x),
            (positions.getY(i) - bounds.min.y) / (bounds.max.y - bounds.min.y),
          );
        }
        geometry.setAttribute('uv', uv);
        panel.geometry = geometry;
        panel.position.copy(cover.position).multiplyScalar(10);
        panel.rotation.copy(cover.rotation);
        panel.scale.copy(cover.scale);
        resources.push(geometry);
      }
      // Live display meshes and the flexible hinge stay under our input and fold control.
      for (const part of [left, right]) {
        for (const child of [...part.children]) {
          if (child.userData['display']) continue;
          part.remove(child);
          const index = hitObjects.indexOf(child);
          if (index !== -1) hitObjects.splice(index, 1);
        }
      }
      buttons.clear();
      buttonTargets.length = 0;
      buttonBases.clear();
      buttonOffsets.clear();
      for (const name of ['side', 'volumeUp', 'volumeDown'] as const) {
        const group = new THREE.Group();
        group.name = `button-${name}`;
        buttons.set(name, group);
        right.add(group);
      }
      for (const [source, target] of [
        [coverBody, left],
        [cameraBody, right],
      ] as const) {
        for (const child of [...source.children]) {
          if (!(child instanceof THREE.Mesh)) continue;
          if (
            child.userData['sourceDisplay'] ||
            ['inner-screen', 'cover-screen'].includes(child.material.name)
          )
            continue;
          // GLB geometry is measured in centimeters; runtime display geometry uses millimeters.
          child.geometry.scale(10, 10, 10);
          child.position.multiplyScalar(10);
          child.geometry.computeBoundingBox();
          const buttonName = child.userData['button'] as DuoButton | undefined;
          if (buttonName && buttons.has(buttonName)) {
            buttons.get(buttonName)!.add(child);
          } else target.add(child);
          hitObjects.push(child);
        }
      }
      for (const [name, group] of buttons) {
        const bounds = new THREE.Box3();
        for (const child of group.children) {
          const mesh = child as THREE.Mesh;
          mesh.updateMatrix();
          bounds.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrix));
        }
        const center = bounds.getCenter(new THREE.Vector3());
        for (const child of group.children) child.position.sub(center);
        group.position.copy(center);
        buttonBases.set(name, center);
        const size = bounds.getSize(new THREE.Vector3());
        const target = box(name === 'side' ? 5 : size.x, name === 'side' ? size.y : 5, depth, 0.1, metal);
        hitObjects.splice(hitObjects.indexOf(target), 1);
        target.position
          .copy(center)
          .add(new THREE.Vector3(name === 'side' ? 2 : 0, name === 'side' ? 0 : 2, 0));
        target.userData['button'] = name;
        target.visible = false;
        target.updateMatrix();
        buttonTargets.push(target);
      }
      device.updateMatrixWorld(true);
    },
    highlightButton: (name?: DuoButton, pressed = false) => {
      hoveredButton = name;
      pressedButton = pressed;
    },
    animateButtons: (dt: number) => {
      let moving = false;
      for (const [name, button] of buttons) {
        const base = buttonBases.get(name)!;
        const goal =
          name === hoveredButton ?
            pressedButton ? 0
            : 0.5
          : 0.16;
        let offset = THREE.MathUtils.damp(buttonOffsets.get(name) ?? 0.16, goal, 22, dt);
        if (Math.abs(offset - goal) < 0.001) offset = goal;
        else moving = true;
        buttonOffsets.set(name, offset);
        button.position.copy(base);
        button.position[name === 'side' ? 'x' : 'y'] += offset;
      }
      return moving;
    },
    dispose: () => {
      disposed = true;
      resources.forEach((resource) => resource.dispose());
    },
  };
}
