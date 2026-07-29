// Procedural three.js device model for the 3D simulator view.
//
// The model is built entirely from primitives (no external GLTF assets, so
// the package stays asset-light): an extruded rounded-rect body with beveled
// edges, a glossy black front plate, the live screen plane (the WebRTC
// <video> mapped as a texture), a subtle glass sheen that catches the
// environment light, plus platform-specific details — Dynamic Island and a
// triple-lens camera plateau for iOS, punch-hole camera and a camera bar for
// Android.
//
// Units: the portrait screen height is 1.0; everything else is derived from
// it so any stream aspect ratio produces a sensibly proportioned device.

import * as THREE from 'three';

export type DevicePlatform3D = 'ios' | 'android';

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
  back: number;
  bodyCornerRadiusFactor: number; // fraction of body width
  screenCornerRadiusFactor: number; // fraction of screen width
}

const PALETTES: Record<DevicePlatform3D, Palette> = {
  ios: {
    // Titanium-ish frame.
    frame: 0x57575c,
    frameMetalness: 0.9,
    frameRoughness: 0.32,
    back: 0x1b1b1e,
    bodyCornerRadiusFactor: 0.13,
    screenCornerRadiusFactor: 0.12,
  },
  android: {
    // Polished dark aluminum (Pixel-like).
    frame: 0x3a3a3e,
    frameMetalness: 0.85,
    frameRoughness: 0.38,
    back: 0x161618,
    bodyCornerRadiusFactor: 0.1,
    screenCornerRadiusFactor: 0.08,
  },
};

/**
 * Build the device. `portraitScreenAspect` is the screen's width/height with
 * the device held upright (always < 1); the caller derives it from the video
 * stream's intrinsic dimensions.
 */
export const buildDeviceModel = (platform: DevicePlatform3D, portraitScreenAspect: number): DeviceModel => {
  const palette = PALETTES[platform];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const track = <G extends THREE.BufferGeometry>(g: G): G => {
    geometries.push(g);
    return g;
  };
  const trackMat = <M extends THREE.Material>(m: M): M => {
    materials.push(m);
    return m;
  };

  const screenH = 1;
  const screenW = screenH * portraitScreenAspect;
  const bezel = 0.02;
  const bodyW = screenW + bezel * 2;
  const bodyH = screenH + bezel * 2;
  const bodyDepth = 0.052;
  const bevel = 0.011;

  const group = new THREE.Group();
  // Child that carries the portrait→landscape physical rotation, so the
  // spin dynamics on `group` stay orientation-agnostic.
  const device = new THREE.Group();
  group.add(device);

  // --- Body -----------------------------------------------------------
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
  const body = new THREE.Mesh(bodyGeometry, frameMaterial);
  device.add(body);

  const frontZ = bodyDepth / 2;
  const backZ = -bodyDepth / 2;

  // --- Front plate (black glass border around the screen) --------------
  const frontPlateMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x060607,
      metalness: 0.2,
      roughness: 0.3,
      envMapIntensity: 0.8,
    }),
  );
  const frontPlateGeometry = track(
    new THREE.ShapeGeometry(
      roundedRectShape(bodyW - 0.008, bodyH - 0.008, bodyW * palette.bodyCornerRadiusFactor - 0.004),
      32,
    ),
  );
  const frontPlate = new THREE.Mesh(frontPlateGeometry, frontPlateMaterial);
  frontPlate.position.z = frontZ + 0.0004;
  device.add(frontPlate);

  // --- Screen -----------------------------------------------------------
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

  // --- Glass sheen over the whole front --------------------------------
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
      roundedRectShape(bodyW - 0.006, bodyH - 0.006, bodyW * palette.bodyCornerRadiusFactor - 0.003),
      32,
    ),
  );
  const glass = new THREE.Mesh(glassGeometry, glassMaterial);
  glass.position.z = frontZ + 0.0018;
  glass.renderOrder = 2;
  device.add(glass);

  const matteBlack = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x030303, metalness: 0.1, roughness: 0.6 }),
  );

  // --- Front camera hardware (sits on top of the streamed screen, like
  // the real cutout sits over the display) ------------------------------
  if (platform === 'ios') {
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

  const addLens = (parent: THREE.Object3D, x: number, y: number, z: number, radius: number) => {
    const barrelGeometry = track(new THREE.CylinderGeometry(radius, radius, 0.01, 32));
    const barrel = new THREE.Mesh(barrelGeometry, lensBarrelMaterial);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(x, y, z - 0.005);
    parent.add(barrel);

    const glassGeometryLens = track(new THREE.CircleGeometry(radius * 0.62, 32));
    const lens = new THREE.Mesh(glassGeometryLens, lensGlassMaterial);
    // Back-facing: rotate so the circle looks along -Z.
    lens.rotation.y = Math.PI;
    lens.position.set(x, y, z - 0.011);
    parent.add(lens);
  };

  if (platform === 'ios') {
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
    addLens(device, px - spread, py + spread, lensZ, lensR);
    addLens(device, px - spread, py - spread, lensZ, lensR);
    addLens(device, px + spread, py, lensZ, lensR);
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
    addLens(device, -barW * 0.18, by, lensZ, barH * 0.3);
    addLens(device, barW * 0.18, by, lensZ, barH * 0.3);
  }

  // --- Side buttons -----------------------------------------------------
  const addButton = (x: number, y: number, length: number) => {
    const geometry = track(new THREE.BoxGeometry(0.008, length, bodyDepth * 0.36));
    const button = new THREE.Mesh(geometry, frameMaterial);
    button.position.set(x, y, 0);
    device.add(button);
  };
  const edgeX = bodyW / 2;
  if (platform === 'ios') {
    addButton(edgeX + 0.001, 0.24, 0.09); // power (right edge)
    addButton(-edgeX - 0.001, 0.33, 0.035); // action button
    addButton(-edgeX - 0.001, 0.25, 0.055); // volume up
    addButton(-edgeX - 0.001, 0.18, 0.055); // volume down
  } else {
    addButton(edgeX + 0.001, 0.28, 0.055); // power
    addButton(edgeX + 0.001, 0.17, 0.1); // volume rocker
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
    boundingRadius: Math.hypot(bodyW, bodyH) / 2 + 0.03,
    setScreenTexture,
    setLandscape,
    dispose,
  };
};
