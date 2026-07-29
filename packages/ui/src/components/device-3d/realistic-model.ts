// Photoreal GLB device models for the 3D simulator view.
//
// Each model is a third-party CC BY 4.0 asset (author/license/source are
// embedded in the glTF `asset.extras` and listed in packages/ui/CREDITS.md),
// optimized with gltf-transform (meshopt compression + WebP textures) and
// shipped as a base64 module behind a dynamic import — so the ~1MB payloads
// are only downloaded when the 3D view actually renders that device.
//
// The loader normalizes each model into the same shape the procedural
// builder produces (see device-model.ts): front facing +Z, top +Y, centered,
// scaled so the case reads at roughly the same size, and with the display
// surface swapped to an unlit material that samples the live WebRTC video.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DeviceModel, DeviceModelKind } from './device-model';

interface RealisticSpec {
  /** Dynamic import of the base64 GLB module (code-split by bundlers). */
  load(): Promise<string>;
  /** glTF material name of the display surface. */
  screenMaterialName: string;
  /** Rotation about Y that turns the display toward +Z. */
  faceRotationY: number;
  /**
   * Base orientation of the screen's UV mapping relative to an upright
   * video frame, verified against orientation markers in the dev harness.
   */
  screenUv: { rotation: number; mirrorX: boolean };
  /** Target world height for the whole model (screen height stays ~1). */
  targetHeight: number;
  /**
   * Vertical pivot for spin, as a fraction of the bounding box height
   * (0 = bottom, 0.5 = center). The watch case sits high above its band
   * loop, so it rotates around the case rather than the loop's middle.
   */
  pivotFractionY: number;
}

const SPECS: Partial<Record<DeviceModelKind, RealisticSpec>> = {
  ios: {
    // "Apple iPhone 15 Pro Max Black" by polyman — CC BY 4.0.
    load: () => import('../../assets/models/iphone-15-pro-max.glb.b64').then((m) => m.default),
    screenMaterialName: 'pIJKfZsazmcpEiU',
    // The display plane faces -Z in the source file.
    faceRotationY: Math.PI,
    // The screen UVs in this export already suit flipY (video/canvas)
    // textures, verified against harness orientation markers.
    screenUv: { rotation: 0, mirrorX: false },
    targetHeight: 1.04,
    pivotFractionY: 0.5,
  },
  watch: {
    // "Apple watch series 5" by atomle — CC BY 4.0.
    load: () => import('../../assets/models/apple-watch-s5.glb.b64').then((m) => m.default),
    screenMaterialName: 'YRNmAgRITIuwDMU',
    faceRotationY: 0,
    screenUv: { rotation: 0, mirrorX: false },
    // The model is a full band loop with the case on top; sized so the case
    // itself reads about as large as the procedural watch case.
    targetHeight: 2.1,
    pivotFractionY: 0.62,
  },
};

export const hasRealisticModel = (kind: DeviceModelKind): boolean => kind in SPECS;

let sharedLoader: GLTFLoader | null = null;
const getLoader = (): GLTFLoader => {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
    sharedLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  return sharedLoader;
};

/**
 * Load and normalize the photoreal model for `kind`. Rejects when no model
 * exists for the kind or the load fails; the caller keeps the procedural
 * model in that case.
 */
export const loadRealisticModel = async (kind: DeviceModelKind): Promise<DeviceModel> => {
  const spec = SPECS[kind];
  if (!spec) throw new Error(`no realistic model for ${kind}`);

  const dataUri = await spec.load();
  const gltf = await getLoader().loadAsync(dataUri);
  const content = gltf.scene;

  // --- Normalize orientation, scale, position --------------------------
  content.rotation.y = spec.faceRotationY;
  content.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(content);
  const size = box.getSize(new THREE.Vector3());
  const scale = spec.targetHeight / size.y;
  content.scale.setScalar(scale);
  content.position.set(
    -(box.min.x + size.x / 2) * scale,
    -(box.min.y + size.y * spec.pivotFractionY) * scale,
    -(box.min.z + size.z / 2) * scale,
  );

  const group = new THREE.Group();
  // Carries the portrait→landscape rotation, like the procedural builder.
  const device = new THREE.Group();
  device.add(content);
  group.add(device);

  const scaledSize = size.clone().multiplyScalar(scale);
  const boundingRadius =
    Math.hypot(
      scaledSize.x,
      Math.max(spec.pivotFractionY, 1 - spec.pivotFractionY) * 2 * scaledSize.y,
      scaledSize.z,
    ) /
      2 +
    0.05;

  // --- Swap the display surface for the live-video material -------------
  const screenMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
  let screenFound = false;
  const originalScreenMaterials: THREE.Material[] = [];
  content.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some((m) => m && m.name === spec.screenMaterialName)) {
      originalScreenMaterials.push(...materials);
      mesh.material = screenMaterial;
      screenFound = true;
    }
  });
  if (!screenFound) throw new Error(`screen material ${spec.screenMaterialName} not found in ${kind} model`);

  // --- API ----------------------------------------------------------------
  let currentTexture: THREE.Texture | null = null;
  let landscape = false;

  const applyTextureOrientation = () => {
    if (!currentTexture) return;
    currentTexture.center.set(0.5, 0.5);
    currentTexture.repeat.x = spec.screenUv.mirrorX ? -1 : 1;
    // The device is physically rotated -90° for landscape; counter-rotate
    // the app content so it reads upright. Under a mirrored U axis the
    // visual sense of a UV rotation flips, hence the sign change.
    const landscapeDelta =
      landscape ?
        spec.screenUv.mirrorX ?
          -Math.PI / 2
        : Math.PI / 2
      : 0;
    currentTexture.rotation = spec.screenUv.rotation + landscapeDelta;
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
    device.rotation.z = next ? -Math.PI / 2 : 0;
    applyTextureOrientation();
  };

  const dispose = () => {
    content.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material || material === screenMaterial) continue;
        disposeMaterial(material);
      }
    });
    for (const material of originalScreenMaterials) disposeMaterial(material);
    screenMaterial.dispose();
  };

  return { group, boundingRadius, setScreenTexture, setLandscape, dispose };
};

const disposeMaterial = (material: THREE.Material) => {
  const anyMat = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(anyMat)) {
    const value = anyMat[key];
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
};
