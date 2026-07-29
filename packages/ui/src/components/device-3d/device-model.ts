// Procedural three.js device models for the 3D simulator view.
//
// Models are built entirely from primitives (no external GLTF assets, so
// the package stays asset-light): an extruded rounded-rect body with beveled
// edges, a glossy black front plate, the live screen plane (the WebRTC
// <video> mapped as a texture), a subtle glass sheen that catches the
// environment light, plus device-specific details:
//
//   - iPhone: Dynamic Island, triple-lens camera plateau, side buttons.
//   - Android: punch-hole camera, camera bar, power/volume buttons.
//   - Apple Watch: chunky rounded case, digital crown, side button, back
//     sensor dome, and the band (straps curling gently backward from the
//     top and bottom lugs).
//
// Units: the portrait screen height is 1.0; everything else is derived from
// it so any stream aspect ratio produces a sensibly proportioned device.

import * as THREE from 'three';

export type DevicePlatform3D = 'ios' | 'android';

/** Which physical device to build. `'ios'` is an iPhone. */
export type DeviceModelKind = 'ios' | 'android' | 'watch';

/** Host-facing model hint; `'auto'` resolves from the stream's aspect. */
export type DeviceModelHint = 'auto' | 'phone' | 'watch';

// Watch simulators stream nearly square (Apple Watch is ~0.82 width/height
// in portrait); phones are ≤ 0.5 and tablets ~0.7-0.75. Anything squarer
// than this on an iOS instance is treated as a watch when the hint is
// 'auto'.
const WATCH_ASPECT_THRESHOLD = 0.78;

/**
 * Resolve which device model to render. Watch simulators are iOS instances
 * (created with `spec.model: 'watch'`), so their stream URL is
 * indistinguishable from an iPhone's — an explicit hint wins, otherwise the
 * stream's portrait aspect ratio decides.
 */
export const resolveDeviceKind = (
  platform: DevicePlatform3D,
  hint: DeviceModelHint,
  portraitAspect: number | null,
): DeviceModelKind => {
  if (platform === 'android') return 'android';
  if (hint === 'watch') return 'watch';
  if (hint === 'phone') return 'ios';
  return portraitAspect !== null && portraitAspect > WATCH_ASPECT_THRESHOLD ? 'watch' : 'ios';
};

export interface DeviceModel {
  /** Root object — add to the scene, rotate from the spin dynamics. */
  group: THREE.Group;
  /** Radius of the model's bounding sphere, for camera distance fitting. */
  boundingRadius: number;
  /** Attach / detach the live screen texture. Pass null for a dark screen. */
  setScreenTexture(texture: THREE.Texture | null): void;
  /**
   * Rotate the physical device for a landscape stream (like turning a real
   * phone sideways). The screen texture is counter-rotated so the app
   * content stays upright.
   */
  setLandscape(landscape: boolean): void;
  /** Release all geometries/materials owned by the model. */
  dispose(): void;
}

const roundedRectShape = (width: number, height: number, radius: number): THREE.Shape => {
  const shape = new THREE.Shape();
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.min(radius, hw, hh);
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(hw, hh - r);
  shape.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-hw + r, hh);
  shape.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-hw, -hh + r);
  shape.absarc(-hw + r, -hh + r, r, Math.PI, (3 * Math.PI) / 2, false);
  return shape;
};

// ShapeGeometry emits UVs in shape-space (world units), not [0, 1]. Remap
// them so a video texture fills the shape exactly.
const remapUvsToUnitSquare = (geometry: THREE.BufferGeometry): void => {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const sizeX = box.max.x - box.min.x || 1;
  const sizeY = box.max.y - box.min.y || 1;
  const position = geometry.getAttribute('position');
  const uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    uvs[i * 2] = (position.getX(i) - box.min.x) / sizeX;
    uvs[i * 2 + 1] = (position.getY(i) - box.min.y) / sizeY;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
};

interface Palette {
  frame: number;
  frameMetalness: number;
  frameRoughness: number;
  bodyCornerRadiusFactor: number; // fraction of body width
  screenCornerRadiusFactor: number; // fraction of screen width
}

const PALETTES: Record<DeviceModelKind, Palette> = {
  ios: {
    // Titanium-ish frame.
    frame: 0x57575c,
    frameMetalness: 0.9,
    frameRoughness: 0.32,
    bodyCornerRadiusFactor: 0.13,
    screenCornerRadiusFactor: 0.12,
  },
  android: {
    // Polished dark aluminum (Pixel-like).
    frame: 0x3a3a3e,
    frameMetalness: 0.85,
    frameRoughness: 0.38,
    bodyCornerRadiusFactor: 0.1,
    screenCornerRadiusFactor: 0.08,
  },
  watch: {
    // Brushed aluminum case; the watch display is nearly all corner radius.
    frame: 0x6a6a70,
    frameMetalness: 0.9,
    frameRoughness: 0.3,
    bodyCornerRadiusFactor: 0.3,
    screenCornerRadiusFactor: 0.24,
  },
};

// Shared per-model resource tracking so dispose() can release everything.
interface ModelBuildContext {
  device: THREE.Group;
  track<G extends THREE.BufferGeometry>(g: G): G;
  trackMat<M extends THREE.Material>(m: M): M;
}

interface BodyDimensions {
  bodyW: number;
  bodyH: number;
  bodyDepth: number;
  bevel: number;
  screenW: number;
  screenH: number;
}

// Build the shared slab: metal body, black front plate, screen plane with
// remapped UVs, and the glass sheen. Returns the screen material (the video
// texture attaches to it) and the front/back z planes for detail placement.
const buildSlab = (ctx: ModelBuildContext, palette: Palette, dims: BodyDimensions) => {
  const { device, track, trackMat } = ctx;
  const { bodyW, bodyH, bodyDepth, bevel, screenW, screenH } = dims;

  const frameMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: palette.frame,
      metalness: palette.frameMetalness,
      roughness: palette.frameRoughness,
      envMapIntensity: 1.1,
    }),
  );
  const bodyShape = roundedRectShape(
    bodyW - bevel * 2,
    bodyH - bevel * 2,
    Math.max(bodyW * palette.bodyCornerRadiusFactor - bevel, 0.01),
  );
  const bodyGeometry = track(
    new THREE.ExtrudeGeometry(bodyShape, {
      depth: bodyDepth - bevel * 2,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 5,
      curveSegments: 32,
    }),
  );
  bodyGeometry.center();
  device.add(new THREE.Mesh(bodyGeometry, frameMaterial));

  const frontZ = bodyDepth / 2;
  const backZ = -bodyDepth / 2;

  const frontPlateMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x060607,
      metalness: 0.2,
      roughness: 0.3,
      envMapIntensity: 0.8,
    }),
  );
  const frontInset = bevel * 0.7;
  const frontPlateGeometry = track(
    new THREE.ShapeGeometry(
      roundedRectShape(
        bodyW - frontInset,
        bodyH - frontInset,
        bodyW * palette.bodyCornerRadiusFactor - frontInset / 2,
      ),
      32,
    ),
  );
  const frontPlate = new THREE.Mesh(frontPlateGeometry, frontPlateMaterial);
  frontPlate.position.z = frontZ + 0.0004;
  device.add(frontPlate);

  const screenMaterial = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      // The screen emits its own light; don't let scene tone mapping dim it.
      toneMapped: false,
    }),
  );
  const screenGeometry = track(
    new THREE.ShapeGeometry(
      roundedRectShape(screenW, screenH, screenW * palette.screenCornerRadiusFactor),
      32,
    ),
  );
  remapUvsToUnitSquare(screenGeometry);
  const screen = new THREE.Mesh(screenGeometry, screenMaterial);
  screen.position.z = frontZ + 0.001;
  device.add(screen);

  const glassMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.06,
      transparent: true,
      opacity: 0.05,
      envMapIntensity: 1.6,
      depthWrite: false,
    }),
  );
  const glassGeometry = track(
    new THREE.ShapeGeometry(
      roundedRectShape(
        bodyW - frontInset * 0.75,
        bodyH - frontInset * 0.75,
        bodyW * palette.bodyCornerRadiusFactor - frontInset / 3,
      ),
      32,
    ),
  );
  const glass = new THREE.Mesh(glassGeometry, glassMaterial);
  glass.position.z = frontZ + 0.0018;
  glass.renderOrder = 2;
  device.add(glass);

  return { frameMaterial, screenMaterial, frontZ, backZ };
};

const buildPhoneDetails = (
  ctx: ModelBuildContext,
  kind: 'ios' | 'android',
  dims: BodyDimensions,
  frameMaterial: THREE.Material,
  frontZ: number,
  backZ: number,
) => {
  const { device, track, trackMat } = ctx;
  const { bodyW, bodyH, bodyDepth, screenW, screenH } = dims;

  const matteBlack = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x030303, metalness: 0.1, roughness: 0.6 }),
  );

  // --- Front camera hardware (sits on top of the streamed screen, like
  // the real cutout sits over the display) ------------------------------
  if (kind === 'ios') {
    // Dynamic Island pill near the top of the screen.
    const islandW = screenW * 0.3;
    const islandH = 0.026;
    const islandGeometry = track(
      new THREE.ShapeGeometry(roundedRectShape(islandW, islandH, islandH / 2), 16),
    );
    const island = new THREE.Mesh(islandGeometry, matteBlack);
    island.position.set(0, screenH / 2 - 0.033, frontZ + 0.0014);
    device.add(island);
  } else {
    // Punch-hole selfie camera.
    const holeGeometry = track(new THREE.CircleGeometry(0.012, 24));
    const hole = new THREE.Mesh(holeGeometry, matteBlack);
    hole.position.set(0, screenH / 2 - 0.028, frontZ + 0.0014);
    device.add(hole);
  }

  // --- Rear camera ------------------------------------------------------
  const lensBarrelMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x28282c,
      metalness: 0.9,
      roughness: 0.25,
      envMapIntensity: 1.2,
    }),
  );
  const lensGlassMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x0a0a14,
      metalness: 0.4,
      roughness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.4,
    }),
  );

  const addLens = (x: number, y: number, z: number, radius: number) => {
    const barrelGeometry = track(new THREE.CylinderGeometry(radius, radius, 0.01, 32));
    const barrel = new THREE.Mesh(barrelGeometry, lensBarrelMaterial);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(x, y, z - 0.005);
    device.add(barrel);

    const glassGeometryLens = track(new THREE.CircleGeometry(radius * 0.62, 32));
    const lens = new THREE.Mesh(glassGeometryLens, lensGlassMaterial);
    // Back-facing: rotate so the circle looks along -Z.
    lens.rotation.y = Math.PI;
    lens.position.set(x, y, z - 0.011);
    device.add(lens);
  };

  if (kind === 'ios') {
    // Rounded-square camera plateau, top-left as seen from the back
    // (world +X when viewed from the front).
    const plateau = bodyW * 0.44;
    const plateauDepth = 0.014;
    const plateauGeometry = track(
      new THREE.ExtrudeGeometry(roundedRectShape(plateau, plateau, plateau * 0.28), {
        depth: plateauDepth,
        bevelEnabled: false,
        curveSegments: 24,
      }),
    );
    const plateauMesh = new THREE.Mesh(plateauGeometry, frameMaterial);
    const px = bodyW / 2 - plateau / 2 - 0.022;
    const py = bodyH / 2 - plateau / 2 - 0.022;
    plateauMesh.position.set(px, py, backZ - plateauDepth + 0.002);
    device.add(plateauMesh);

    const lensR = plateau * 0.19;
    const lensZ = backZ - plateauDepth + 0.002;
    const spread = plateau * 0.22;
    addLens(px - spread, py + spread, lensZ, lensR);
    addLens(px - spread, py - spread, lensZ, lensR);
    addLens(px + spread, py, lensZ, lensR);
  } else {
    // Full-width camera bar.
    const barW = bodyW * 0.88;
    const barH = 0.085;
    const barDepth = 0.012;
    const barGeometry = track(
      new THREE.ExtrudeGeometry(roundedRectShape(barW, barH, barH / 2), {
        depth: barDepth,
        bevelEnabled: false,
        curveSegments: 24,
      }),
    );
    const bar = new THREE.Mesh(barGeometry, lensBarrelMaterial);
    const by = bodyH / 2 - 0.1;
    bar.position.set(0, by, backZ - barDepth + 0.002);
    device.add(bar);

    const lensZ = backZ - barDepth + 0.002;
    addLens(-barW * 0.18, by, lensZ, barH * 0.3);
    addLens(barW * 0.18, by, lensZ, barH * 0.3);
  }

  // --- Side buttons -----------------------------------------------------
  const addButton = (x: number, y: number, length: number) => {
    const geometry = track(new THREE.BoxGeometry(0.008, length, bodyDepth * 0.36));
    const button = new THREE.Mesh(geometry, frameMaterial);
    button.position.set(x, y, 0);
    device.add(button);
  };
  const edgeX = bodyW / 2;
  if (kind === 'ios') {
    addButton(edgeX + 0.001, 0.24, 0.09); // power (right edge)
    addButton(-edgeX - 0.001, 0.33, 0.035); // action button
    addButton(-edgeX - 0.001, 0.25, 0.055); // volume up
    addButton(-edgeX - 0.001, 0.18, 0.055); // volume down
  } else {
    addButton(edgeX + 0.001, 0.28, 0.055); // power
    addButton(edgeX + 0.001, 0.17, 0.1); // volume rocker
  }
};

// Band strap length beyond the case edge, backward curl, and thickness.
// Exposed to the bounding-radius math below.
const STRAP_LENGTH = 0.72;
const STRAP_BEND = 0.34;
const STRAP_THICKNESS = 0.05;

const buildWatchDetails = (
  ctx: ModelBuildContext,
  dims: BodyDimensions,
  frameMaterial: THREE.Material,
  backZ: number,
) => {
  const { device, track, trackMat } = ctx;
  const { bodyW, bodyH, bodyDepth } = dims;

  // --- Digital crown + side button (right edge) -------------------------
  // The crown is a disc whose rotation axis points out of the case's right
  // side (local +X).
  const crownRadius = 0.085;
  const crownWidth = 0.055;
  const crownGeometry = track(new THREE.CylinderGeometry(crownRadius, crownRadius, crownWidth, 32));
  const crown = new THREE.Mesh(crownGeometry, frameMaterial);
  crown.rotation.z = Math.PI / 2;
  crown.position.set(bodyW / 2 + crownWidth / 2 - 0.015, bodyH * 0.18, bodyDepth * 0.1);
  device.add(crown);
  // Darker crown cap for a bit of read as a separate part.
  const capMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({ color: 0x2c2c30, metalness: 0.85, roughness: 0.35 }),
  );
  const capGeometry = track(new THREE.CylinderGeometry(crownRadius * 0.55, crownRadius * 0.55, 0.004, 24));
  const cap = new THREE.Mesh(capGeometry, capMaterial);
  cap.rotation.z = Math.PI / 2;
  cap.position.set(bodyW / 2 + crownWidth - 0.013, bodyH * 0.18, bodyDepth * 0.1);
  device.add(cap);

  const sideButtonGeometry = track(new THREE.BoxGeometry(0.018, 0.22, bodyDepth * 0.28));
  const sideButton = new THREE.Mesh(sideButtonGeometry, frameMaterial);
  sideButton.position.set(bodyW / 2 + 0.002, -bodyH * 0.14, bodyDepth * 0.08);
  device.add(sideButton);

  // --- Back sensor dome ---------------------------------------------------
  const sensorMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x111114,
      metalness: 0.3,
      roughness: 0.25,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
    }),
  );
  const sensorGeometry = track(new THREE.CylinderGeometry(bodyW * 0.28, bodyW * 0.3, 0.03, 40));
  const sensor = new THREE.Mesh(sensorGeometry, sensorMaterial);
  sensor.rotation.x = Math.PI / 2;
  sensor.position.set(0, 0, backZ - 0.008);
  device.add(sensor);

  // --- Band ("cordon") ----------------------------------------------------
  // Each strap is an extruded curved profile: it leaves the lug channel and
  // curls gently backward, like a sport band resting on a surface. Profile
  // space: shape.x = depth (curls toward -x = behind the case), shape.y =
  // distance along the strap; extrusion = strap width. After rotateY(-90°)
  // the extrusion axis lands on world X, shape.y stays world Y (up) and
  // shape.x lands on world Z.
  const strapMaterial = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x2f4a63, metalness: 0, roughness: 0.85 }),
  );
  const strapW = bodyW * 0.56;
  const t = STRAP_THICKNESS;
  const profile = new THREE.Shape();
  profile.moveTo(-t / 2, 0);
  profile.quadraticCurveTo(-t / 2, STRAP_LENGTH * 0.62, -t / 2 - STRAP_BEND, STRAP_LENGTH);
  profile.lineTo(t / 2 - STRAP_BEND, STRAP_LENGTH);
  profile.quadraticCurveTo(t / 2, STRAP_LENGTH * 0.62, t / 2, 0);
  profile.lineTo(-t / 2, 0);

  const strapGeometry = track(
    new THREE.ExtrudeGeometry(profile, {
      depth: strapW - 0.02,
      bevelEnabled: true,
      bevelThickness: 0.01,
      bevelSize: 0.01,
      bevelSegments: 3,
      curveSegments: 24,
    }),
  );
  strapGeometry.rotateY(-Math.PI / 2);
  strapGeometry.center();
  strapGeometry.computeBoundingBox();
  const strapBox = strapGeometry.boundingBox!;

  // Tuck the strap root into the lug channel; the profile starts at y=0 so
  // after center() the mesh spans symmetrically — position by its box.
  const rootOverlap = 0.06;
  const topStrap = new THREE.Mesh(strapGeometry, strapMaterial);
  topStrap.position.set(0, bodyH / 2 - rootOverlap - strapBox.min.y, -strapBox.max.z + bodyDepth * 0.12);
  device.add(topStrap);

  const bottomStrap = new THREE.Mesh(strapGeometry, strapMaterial);
  bottomStrap.rotation.z = Math.PI;
  bottomStrap.position.set(
    0,
    -(bodyH / 2 - rootOverlap - strapBox.min.y),
    -strapBox.max.z + bodyDepth * 0.12,
  );
  device.add(bottomStrap);
};

/**
 * Build the device. `portraitScreenAspect` is the screen's width/height with
 * the device held upright (always < 1); the caller derives it from the video
 * stream's intrinsic dimensions.
 */
export const buildDeviceModel = (kind: DeviceModelKind, portraitScreenAspect: number): DeviceModel => {
  const palette = PALETTES[kind];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const group = new THREE.Group();
  // Child that carries the portrait→landscape physical rotation, so the
  // spin dynamics on `group` stay orientation-agnostic.
  const device = new THREE.Group();
  group.add(device);

  const ctx: ModelBuildContext = {
    device,
    track: (g) => {
      geometries.push(g);
      return g;
    },
    trackMat: (m) => {
      materials.push(m);
      return m;
    },
  };

  const screenH = 1;
  const screenW = screenH * portraitScreenAspect;
  const dims: BodyDimensions =
    kind === 'watch' ?
      {
        // Real-watch proportions: the case is chunky (~0.21 of its height
        // deep) with generous bezels and very round corners.
        bodyW: screenW + 0.17,
        bodyH: screenH + 0.2,
        bodyDepth: 0.24,
        bevel: 0.045,
        screenW,
        screenH,
      }
    : {
        bodyW: screenW + 0.04,
        bodyH: screenH + 0.04,
        bodyDepth: 0.052,
        bevel: 0.011,
        screenW,
        screenH,
      };

  const { frameMaterial, screenMaterial, frontZ, backZ } = buildSlab(ctx, palette, dims);

  let boundingRadius: number;
  if (kind === 'watch') {
    buildWatchDetails(ctx, dims, frameMaterial, backZ);
    // Straps dominate the vertical extent; include their length and curl.
    const strapReachY = dims.bodyH / 2 - 0.06 + STRAP_LENGTH;
    const reachZ = STRAP_BEND + STRAP_THICKNESS + dims.bodyDepth / 2;
    boundingRadius =
      Math.max(Math.hypot(dims.bodyW / 2, strapReachY), Math.hypot(reachZ, strapReachY * 0.8)) + 0.03;
  } else {
    buildPhoneDetails(ctx, kind, dims, frameMaterial, frontZ, backZ);
    boundingRadius = Math.hypot(dims.bodyW, dims.bodyH) / 2 + 0.03;
  }

  // --- API ---------------------------------------------------------------
  let currentTexture: THREE.Texture | null = null;
  let landscape = false;

  const applyTextureOrientation = () => {
    if (!currentTexture) return;
    currentTexture.center.set(0.5, 0.5);
    // The device is physically rotated -90° for landscape; counter-rotate
    // the app content so it reads upright.
    currentTexture.rotation = landscape ? Math.PI / 2 : 0;
  };

  const setScreenTexture = (texture: THREE.Texture | null) => {
    currentTexture = texture;
    screenMaterial.map = texture;
    screenMaterial.color.set(texture ? 0xffffff : 0x000000);
    screenMaterial.needsUpdate = true;
    applyTextureOrientation();
  };

  const setLandscape = (next: boolean) => {
    landscape = next;
    // Top of the device goes to the viewer's right, like rotating a phone
    // into landscape with your hands.
    device.rotation.z = next ? -Math.PI / 2 : 0;
    applyTextureOrientation();
  };

  const dispose = () => {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  };

  return {
    group,
    boundingRadius,
    setScreenTexture,
    setLandscape,
    dispose,
  };
};
