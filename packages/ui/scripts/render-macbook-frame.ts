// Renders the 2D MacBook frame, src/assets/macbook_pro_frame.webp, from the prepared model that
// prepare-macbook-model.mjs makes. Serve this package with `yarn vite` and open
// /scripts/render-macbook-frame.html?model=<url of the prepared GLB>. The page shows the frame, a
// PNG to download, and the screen's place in it for `macos.screen` in src/frame-assets.ts. With
// &save=<url> it also POSTs the PNG there. Convert the PNG to WebP:
//   cwebp -q 90 -alpha_q 100 macbook_pro_frame.png -o src/assets/macbook_pro_frame.webp
//
// The camera looks square at the screen, so the screen's opening is a rectangle the stream fills.
// The lid leans back, so the same camera looks down onto the keyboard. The opening is where the
// screen shows, the notch kept in front of it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { lidRotation } from '../src/components/macbook-geometry';
import { createStudioEnvironment } from '../src/components/studio-environment';

// How far the lid opens, in degrees from closed, and the frame's pixels per hundredth of the
// screen's width.
const LID_DEGREES = 104;
const PIXELS_PER_UNIT = 20;

const params = new URLSearchParams(location.search);
const modelUrl = params.get('model');
const status = document.getElementById('status')!;
if (!modelUrl) throw new Error('Pass ?model=<url of the prepared GLB>.');

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const { scene: model } = await loader.loadAsync(modelUrl);
const lid = model.getObjectByName('macbook-lid');
const screen = model.getObjectByName('macbook-screen');
if (!lid || !(screen instanceof THREE.Mesh))
  throw new Error('The model has no macbook-lid or macbook-screen.');
lid.rotation.x = lidRotation(LID_DEGREES);
model.updateMatrixWorld(true);

// The screen faces along the lid's turned z axis; its up is the lid's turned y axis.
const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lid.rotation.x);
const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(turn);
const up = new THREE.Vector3(0, 1, 0).applyQuaternion(turn);
const screenBox = new THREE.Box3().setFromObject(screen);
const target = screenBox.getCenter(new THREE.Vector3());
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
camera.position.copy(target).addScaledVector(facing, 600);
camera.up.copy(up);
camera.lookAt(target);
camera.updateMatrixWorld(true);

// Bounds of a set of meshes in the camera's view, from every vertex.
const viewBounds = (root: THREE.Object3D) => {
  const box = new THREE.Box2(new THREE.Vector2(Infinity, Infinity), new THREE.Vector2(-Infinity, -Infinity));
  const point = new THREE.Vector3();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      point
        .fromBufferAttribute(position, i)
        .applyMatrix4(object.matrixWorld)
        .applyMatrix4(camera.matrixWorldInverse);
      box.expandByPoint(new THREE.Vector2(point.x, point.y));
    }
  });
  return box;
};
const frame = viewBounds(model);
const margin = 1;
frame.min.subScalar(margin);
frame.max.addScalar(margin);
camera.left = frame.min.x;
camera.right = frame.max.x;
camera.bottom = frame.min.y;
camera.top = frame.max.y;
camera.updateProjectionMatrix();
const width = Math.round((frame.max.x - frame.min.x) * PIXELS_PER_UNIT);
const height = Math.round((frame.max.y - frame.min.y) * PIXELS_PER_UNIT);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
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

// The frame: the MacBook with the screen's opening cleared.
const pixels = beauty.getImageData(0, 0, width, height);
const shown = mask.getImageData(0, 0, width, height).data;
for (let i = 0; i < pixels.data.length; i += 4) {
  pixels.data[i + 3] = Math.round(pixels.data[i + 3]! * (1 - shown[i]! / 255));
}
beauty.putImageData(pixels, 0, 0);

// The screen's rectangle in the frame, as fractions of its width and height.
const opening = viewBounds(screen);
const place = {
  left: (opening.min.x - frame.min.x) / (frame.max.x - frame.min.x),
  top: (frame.max.y - opening.max.y) / (frame.max.y - frame.min.y),
  width: (opening.max.x - opening.min.x) / (frame.max.x - frame.min.x),
  height: (opening.max.y - opening.min.y) / (frame.max.y - frame.min.y),
};
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
