// Renders the 2D MacBook frame, src/assets/macbook_pro_frame.webp, from the prepared model that
// prepare-macbook-model.mjs makes. Serve this package with `yarn vite` and open
// /scripts/render-macbook-frame.html?model=<url of the prepared GLB>. The page shows the frame, a
// PNG to download, and the screen's place in it for `macos.screen` in src/frame-assets.ts. With
// &save=<url> it also POSTs the PNG there. Convert the PNG to WebP:
//   cwebp -q 90 -alpha_q 100 macbook_pro_frame.png -o src/assets/macbook_pro_frame.webp
//
// A perspective camera looks square at the screen's center, so the screen's opening is a rectangle
// the stream fills, while the rest of the MacBook keeps its perspective, as in a photograph. The
// frame is the lid alone, without the base or the hinge under the lid: a keyboard below the screen
// would shrink the screen in a viewer's space. The opening is wherever the
// screen shows, so the notch stays in the frame over its top edge; `notch` reports the share of the
// opening's height the notch takes; RemoteControl starts the stream at the top, under the notch.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { lidRotation } from '../src/components/macbook-geometry';
import { createStudioEnvironment } from '../src/components/studio-environment';

// How far the lid opens, in degrees from closed; the camera's distance from the screen, in
// hundredths of its width, about where a person sits from a laptop (nearer exaggerates the
// perspective); and the screen's width in the frame, in pixels.
const LID_DEGREES = 100;
const DISTANCE = 300;
const SCREEN_PIXELS = 2000;

const params = new URLSearchParams(location.search);
const modelUrl = params.get('model');
const status = document.getElementById('status')!;
if (!modelUrl) throw new Error('Pass ?model=<url of the prepared GLB>.');

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const { scene: model } = await loader.loadAsync(modelUrl);
const base = model.getObjectByName('macbook-base');
const lid = model.getObjectByName('macbook-lid');
const screen = model.getObjectByName('macbook-screen');
if (!base || !lid || !(screen instanceof THREE.Mesh))
  throw new Error('The model has no macbook-base, macbook-lid or macbook-screen.');
base.visible = false;
// The bezel has a cutout along its bottom for the hinge, which the hinge and its cover fill and the
// aluminium back shows through. Without them the frame is the lid's outline alone: the cover's
// strip is clipped off under the chin, the back draws only its outside, and a piece of bezel fills
// the cutout. Measures are in the lid's own units, from the model.
const bezel = model.getObjectByName('Object_131');
const cover = model.getObjectByName('Object_111');
const back = model.getObjectByName('Object_103');
if (!(bezel instanceof THREE.Mesh) || !(cover instanceof THREE.Mesh) || !(back instanceof THREE.Mesh))
  throw new Error("The model has no lid bezel, hinge cover or back where it's expected.");
const CHIN_BOTTOM = 0.09;
const BEZEL_BOTTOM = -0.71;
const CUTOUT_HALF_WIDTH = 41;
const BACK_BOTTOM = -0.94;
const aluminium = back.material as THREE.Material;
back.material = (back.material as THREE.Material).clone();
(back.material as THREE.Material).side = THREE.FrontSide;
const coverClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), -CHIN_BOTTOM);
cover.material = (cover.material as THREE.Material).clone();
(cover.material as THREE.Material).clippingPlanes = [coverClip];
const fill = new THREE.Mesh(
  new THREE.PlaneGeometry(2 * CUTOUT_HALF_WIDTH, CHIN_BOTTOM - BEZEL_BOTTOM),
  bezel.material as THREE.Material,
);
fill.position.set(0, (CHIN_BOTTOM + BEZEL_BOTTOM) / 2, -1.8);
lid.add(fill);
const backEdge = new THREE.Mesh(
  new THREE.PlaneGeometry(2 * CUTOUT_HALF_WIDTH, BEZEL_BOTTOM - BACK_BOTTOM),
  aluminium,
);
backEdge.position.set(0, (BEZEL_BOTTOM + BACK_BOTTOM) / 2, -1.85);
lid.add(backEdge);
// The hinge itself is the lid's other parts under the screen that are narrower than it.
const lidBox = (object: THREE.Mesh) => {
  object.geometry.computeBoundingBox();
  return object.geometry.boundingBox!.clone().applyMatrix4(object.matrix);
};
const screenInLid = lidBox(screen);
for (const object of lid.children) {
  if (!(object instanceof THREE.Mesh) || object === screen || object === fill || object === backEdge)
    continue;
  const box = lidBox(object);
  if (box.max.y < screenInLid.min.y && box.max.x - box.min.x < screenInLid.max.x - screenInLid.min.x) {
    object.visible = false;
  }
}
lid.rotation.x = lidRotation(LID_DEGREES);
model.updateMatrixWorld(true);
coverClip.applyMatrix4(lid.matrixWorld);

// The screen faces along the lid's turned z axis; its up is the lid's turned y axis.
const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lid.rotation.x);
const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(turn);
const up = new THREE.Vector3(0, 1, 0).applyQuaternion(turn);
const screenBox = new THREE.Box3().setFromObject(screen);
const target = screenBox.getCenter(new THREE.Vector3());
const camera = new THREE.PerspectiveCamera(60, 1, 1, 4000);
camera.position.copy(target).addScaledVector(facing, DISTANCE);
camera.up.copy(up);
camera.lookAt(target);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

// Bounds of the meshes that draw, on the camera's image, in normalized device coordinates.
const viewBounds = (root: THREE.Object3D) => {
  const box = new THREE.Box2(new THREE.Vector2(Infinity, Infinity), new THREE.Vector2(-Infinity, -Infinity));
  const point = new THREE.Vector3();
  root.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).project(camera);
      box.expandByPoint(new THREE.Vector2(point.x, point.y));
    }
  });
  return box;
};
const frame = viewBounds(lid);
const opening = viewBounds(screen);
// The camera renders only the lid's part of its image, at the scale that makes the screen
// SCREEN_PIXELS wide, with a margin around it.
const pixelsPerUnit = SCREEN_PIXELS / (opening.max.x - opening.min.x);
frame.expandByScalar(16 / pixelsPerUnit);
const width = Math.round((frame.max.x - frame.min.x) * pixelsPerUnit);
const height = Math.round((frame.max.y - frame.min.y) * pixelsPerUnit);
camera.setViewOffset(
  2 * pixelsPerUnit,
  2 * pixelsPerUnit,
  (frame.min.x + 1) * pixelsPerUnit,
  (1 - frame.max.y) * pixelsPerUnit,
  width,
  height,
);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.localClippingEnabled = true;
renderer.setSize(width, height, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const environment = createStudioEnvironment(renderer);
scene.environment = environment.texture;
scene.environmentIntensity = 0.45;
scene.add(new THREE.HemisphereLight(0xffffff, 0xc1c8d1, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(-120, 220, 260);
scene.add(key);
const rim = new THREE.DirectionalLight(0xe4edff, 0.7);
rim.position.set(220, 40, -220);
scene.add(rim);
scene.add(model);

const capture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.drawImage(renderer.domElement, 0, 0);
  return context;
};

// The MacBook as the 3D mode lights it, its screen black glass.
screen.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.render(scene, camera);
const beauty = capture();

// Where the screen shows: white for the screen, black for everything in front of or around it.
const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
const materials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
model.traverse((object) => {
  if (object instanceof THREE.Mesh) {
    materials.set(object, object.material);
    object.material = object === screen ? new THREE.MeshBasicMaterial({ color: 0xffffff }) : black;
  }
});
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0x000000, 1);
renderer.render(scene, camera);
const mask = capture();

// The screen's rectangle, as fractions of the frame's width and height, and the notch's share of it.
const place = {
  left: (opening.min.x - frame.min.x) / (frame.max.x - frame.min.x),
  top: (frame.max.y - opening.max.y) / (frame.max.y - frame.min.y),
  width: (opening.max.x - opening.min.x) / (frame.max.x - frame.min.x),
  height: (opening.max.y - opening.min.y) / (frame.max.y - frame.min.y),
  notch: Number(screen.userData['notch'] ?? 0),
};

// The frame: the MacBook with the screen's opening cleared around the notch.
const pixels = beauty.getImageData(0, 0, width, height);
const shown = mask.getImageData(0, 0, width, height).data;
for (let i = 0; i < pixels.data.length; i += 4) {
  pixels.data[i + 3] = Math.round(pixels.data[i + 3]! * (1 - shown[i]! / 255));
}
beauty.putImageData(pixels, 0, 0);
const blob = await new Promise<Blob>((resolve) => beauty.canvas.toBlob((b) => resolve(b!), 'image/png'));
const result = { width, height, screen: place };
document.body.append(beauty.canvas);
const link = Object.assign(document.createElement('a'), {
  href: URL.createObjectURL(blob),
  download: 'macbook_pro_frame.png',
  textContent: 'Download macbook_pro_frame.png',
});
document.body.append(link);
status.textContent = JSON.stringify(result);
const save = params.get('save');
if (save) {
  await fetch(`${save}/macbook_pro_frame.png`, { method: 'POST', body: blob });
  await fetch(`${save}/macbook_pro_frame.json`, { method: 'POST', body: JSON.stringify(result, null, 2) });
  status.textContent += ' saved';
}
