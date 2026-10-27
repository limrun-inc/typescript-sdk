import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { createDuoModel } from '../src/components/duo-model';
import DuoView from '../src/components/duo-view';
import { RemoteControl } from '../src/components/remote-control-framed';
import type { DuoState } from '../src/core/duo';
import '../src/components/remote-control.css';

const root = createRoot(document.getElementById('root')!);
const videos: HTMLVideoElement[] = [];
const refresh: ReturnType<typeof setInterval>[] = [];

async function source(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  const draw = () => {
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, width, height);
  };
  draw();
  refresh.push(setInterval(draw, 30));
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = canvas.captureStream(30);
  await video.play();
  videos.push(video);
  return video;
}

async function mount({
  angle = 180,
  orientation = 'portrait',
  modelUrl,
}: {
  angle?: number;
  orientation?: DuoState['orientation'];
  modelUrl?: string;
}) {
  refresh.splice(0).forEach(clearInterval);
  for (const v of videos.splice(0)) (v.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
  const outer = await source(771, 1122);
  const inner = await source(1108, 1575);
  function Fixture() {
    const [state, setState] = React.useState<DuoState>({
      angleDegrees: angle,
      minAngleDegrees: 0,
      maxAngleDegrees: 180,
      orientation,
      displays: [
        { id: 'outer', screenId: 1, trackId: 'outer', width: 1398, height: 2034, scale: 3, orientation: 1 },
        { id: 'inner', screenId: 2, trackId: 'inner', width: 2034, height: 2912, scale: 3, orientation: 3 },
      ],
    });
    return (
      <DuoView
        outer={outer}
        inner={inner}
        state={state}
        modelUrl={modelUrl}
        setAngle={async (angleDegrees) => setState((s) => ({ ...s, angleDegrees }))}
        setOrientation={async (orientation) => setState((s) => ({ ...s, orientation }))}
        button={async () => {}}
        touch={() => {}}
        onKeyDown={() => {}}
        onKeyUp={() => {}}
      />
    );
  }
  root.render(<Fixture key={Math.random()} />);
}

async function createFixture(modelUrl?: string) {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  const model = createDuoModel(texture, texture);
  if (modelUrl) await model.loadAppearance(modelUrl);
  const scene = new THREE.Scene();
  scene.add(model.device, new THREE.HemisphereLight(0xffffff, 0xffffff, 2));
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x888888);
  return { model, scene, renderer };
}
const fixtures = new Map<string, Promise<Awaited<ReturnType<typeof createFixture>>>>();

// Compare the full render against the same live screen meshes without the chassis.
// The reference excludes silhouette antialiasing and detects actual occlusion of the image.
async function hinge({
  width,
  height,
  dpr,
  yaw,
  pitch,
  angle = 180,
  modelUrl,
}: {
  width: number;
  height: number;
  dpr: number;
  yaw: number;
  pitch: number;
  angle?: number;
  modelUrl?: string;
}) {
  const key = modelUrl ?? 'procedural';
  if (!fixtures.has(key)) fixtures.set(key, createFixture(modelUrl));
  const { model, scene, renderer } = await fixtures.get(key)!;
  model.setAngle(angle);
  model.device.rotation.set(pitch, yaw, 0);
  model.device.updateMatrixWorld(true);
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height);
  const aspect = width / height;
  const halfHeight = Math.max(70, 95 / aspect);
  const camera = new THREE.OrthographicCamera(
    -halfHeight * aspect,
    halfHeight * aspect,
    halfHeight,
    -halfHeight,
    1,
    2000,
  );
  camera.position.z = 340;
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth,
    h = gl.drawingBufferHeight;
  const pixels = () => {
    renderer.render(scene, camera);
    const bytes = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  };
  const actual = pixels();
  const screenshot = renderer.domElement.toDataURL('image/png');
  const visibility = new Map<THREE.Object3D, boolean>();
  model.device.traverse((o) => visibility.set(o, o.visible));
  model.device.traverse((o) => {
    if (o instanceof THREE.Mesh && o.userData['display'] !== 'inner') o.visible = false;
  });
  const reference = pixels();
  const point = (x: number, y: number) =>
    new THREE.Vector3(x, y, 0.14).applyMatrix4(model.device.matrixWorld).project(camera);
  const a = point(-5, -35),
    b = point(5, 35);
  const x0 = Math.floor(((Math.min(a.x, b.x) + 1) * w) / 2),
    x1 = Math.ceil(((Math.max(a.x, b.x) + 1) * w) / 2);
  const y0 = Math.floor(((Math.min(a.y, b.y) + 1) * h) / 2),
    y1 = Math.ceil(((Math.max(a.y, b.y) + 1) * h) / 2);
  let darkPixels = 0,
    worstDrop = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      if (reference[i]! < 250) continue;
      const drop = reference[i]! - actual[i]!;
      if (drop > 12) darkPixels++;
      worstDrop = Math.max(worstDrop, drop);
    }
  const samples = gl.getParameter(gl.SAMPLES);
  model.device.traverse((o) => {
    o.visible = visibility.get(o)!;
  });
  return { darkPixels, worstDrop, samples, screenshot };
}

function stream({ url, token }: { url: string; token: string }) {
  root.render(
    <div style={{ width: '100vw', height: '100vh' }}>
      <RemoteControl url={url} token={token} platform="ios" />
    </div>,
  );
}

Object.assign(window, { validation: { mount, hinge, stream } });
