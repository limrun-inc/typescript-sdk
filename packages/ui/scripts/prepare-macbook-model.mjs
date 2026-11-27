// Prepares src/assets/macbook_pro_16.glb, the model RemoteControl's 3D MacBook draws, from
// "macbook pro M3 16 inch 2024" by jackbaeten, CC BY 4.0:
// https://sketchfab.com/3d-models/8e34fc2b303144f78490007d91ff57c4
// Whoever serves the result, the package or a host through macbookModelUrl, credits the author as
// CC BY asks; the README does for the package.
//
// Download the model's GLB (2k textures) from Sketchfab, then, from a folder with
// @gltf-transform/core, @gltf-transform/extensions and @gltf-transform/functions 4.x, meshoptimizer
// and sharp installed:
//   node prepare-macbook-model.mjs macbook_pro_m3_16_inch_2024.glb macbook_pro_16.glb
//
// The prepared model is the contract macbook-frame.tsx loads:
// - Units are hundredths of the screen's width; x right, y up, z toward the viewer.
// - The hinge is the x axis. `macbook-lid` stands upright on it, and turning that node about x
//   opens or closes the lid; a quarter turn closes it flat on the keyboard deck, its edges flush
//   with the base's. `macbook-base` holds the rest.
// - `macbook-screen` is the display, under the lid, with plain black glass for a material and
//   texture coordinates from (0, 0) at its bottom left to (1, 1) at its top right. Its extras carry
//   the display's aspect ratio and `notch`, the share of its height the notch takes at its top, so
//   the stream can start at the top, the notch over its menu bar, as on a MacBook.
// It drops Apple's wallpaper and the lettering under the base, and keeps the logo on the lid.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: node prepare-macbook-model.mjs <in.glb> <out.glb>');

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const document = await io.read(input);
const root = document.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];

// The source's parts, by the names its Sketchfab export gives them.
const byName = (name) => {
  const node = root.listNodes().find((n) => n.getName() === name);
  if (!node) throw new Error(`the model has no node ${name}; is it the model this script prepares?`);
  return node;
};
const lidGroup = byName('VCQqxpxkUlzqcJI_62');
const baseGroup = byName('BoBvWqDHZjAeVrp_44');
const screenNode = byName('Object_123');
const hingeNode = byName('Object_99');
const lettering = ['Object_54', 'Object_82'].map(byName);

// Every mesh node under a group, with its world matrix.
const meshesUnder = (group) => {
  const found = [];
  const walk = (node) => {
    if (node.getMesh()) found.push(node);
    node.listChildren().forEach(walk);
  };
  walk(group);
  return found;
};

// World-space bounds of a node's mesh.
const boundsOf = (node) => {
  const matrix = node.getWorldMatrix();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of node.getMesh().listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    const p = [0, 0, 0];
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, p);
      const w = transform(matrix, p);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], w[a]);
        max[a] = Math.max(max[a], w[a]);
      }
    }
  }
  return { min, max };
};
function transform(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// The hinge barrel's axis, the open lid's lean, and the display's size set the target frame.
const hinge = boundsOf(hingeNode);
const hingeY = (hinge.min[1] + hinge.max[1]) / 2;
const hingeZ = (hinge.min[2] + hinge.max[2]) / 2;
const screen = boundsOf(screenNode);
// The open lid leans back: its top is further from the viewer than its bottom.
const lean = Math.atan2(screen.max[2] - screen.min[2], screen.max[1] - screen.min[1]);
const scale = 100 / (screen.max[0] - screen.min[0]);

// Moves a world point into the target frame, standing the lid's points upright about the hinge.
const place = (point, upright) => {
  let y = point[1] - hingeY;
  let z = point[2] - hingeZ;
  if (upright) [y, z] = [y * Math.cos(lean) - z * Math.sin(lean), y * Math.sin(lean) + z * Math.cos(lean)];
  return [point[0] * scale, y * scale, z * scale];
};
const placeNormal = (normal, upright) => {
  let [x, y, z] = normal;
  if (upright) [y, z] = [y * Math.cos(lean) - z * Math.sin(lean), y * Math.sin(lean) + z * Math.cos(lean)];
  return [x, y, z];
};

for (const node of lettering) node.dispose();

// Rebuilds a part's meshes in the target frame, under one named node.
const lid = document.createNode('macbook-lid');
const base = document.createNode('macbook-base');
const rebuild = (group, target, upright) => {
  for (const node of meshesUnder(group)) {
    const matrix = node.getWorldMatrix();
    const normalMatrix = matrix.slice();
    normalMatrix[12] = normalMatrix[13] = normalMatrix[14] = 0;
    const mesh = node.getMesh().clone();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION').clone();
      const p = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i++) {
        position.getElement(i, p);
        position.setElement(i, place(transform(matrix, p), upright));
      }
      primitive.setAttribute('POSITION', position);
      const normals = primitive.getAttribute('NORMAL');
      if (normals) {
        const copy = normals.clone();
        const n = [0, 0, 0];
        for (let i = 0; i < copy.getCount(); i++) {
          copy.getElement(i, n);
          const turned = placeNormal(transform(normalMatrix, n), upright);
          const length = Math.hypot(...turned) || 1;
          copy.setElement(
            i,
            turned.map((v) => v / length),
          );
        }
        primitive.setAttribute('NORMAL', copy);
      }
      // Tangents would need turning too; normal maps rebuild them on load.
      primitive.setAttribute('TANGENT', null);
    }
    const part = document.createNode(node === screenNode ? 'macbook-screen' : node.getName()).setMesh(mesh);
    target.addChild(part);
    if (node === screenNode) prepareScreen(part);
  }
};

// The display: black glass, texture coordinates spanning it, and its aspect ratio. It sits on the
// lid's black glass, which a depth test cannot tell apart from it, so it moves just in front. A
// black pixel textures it, since pruning drops texture coordinates no texture reads.
const SCREEN_LIFT = 0.05;
// The notch's share of the display's height. The 16-inch panel is 3456 × 2234 pixels, and macOS keeps
// the top 74 rows, which the notch splits, out of an app's way: what remains is 16:10.
const NOTCH = 74 / 2234;
const blackPixel = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
  .png()
  .toBuffer();
function prepareScreen(part) {
  const glass = document
    .createMaterial('macbook-screen')
    .setBaseColorFactor([0, 0, 0, 1])
    .setBaseColorTexture(
      document.createTexture('macbook-screen').setImage(blackPixel).setMimeType('image/png'),
    )
    .setMetallicFactor(0)
    .setRoughnessFactor(0.1);
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  const p = [0, 0, 0];
  for (const primitive of part.getMesh().listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, p);
      for (const a of [0, 1]) {
        min[a] = Math.min(min[a], p[a]);
        max[a] = Math.max(max[a], p[a]);
      }
    }
  }
  for (const primitive of part.getMesh().listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, p);
      position.setElement(i, [p[0], p[1], p[2] + SCREEN_LIFT]);
    }
    const uv = document
      .createAccessor()
      .setType('VEC2')
      .setArray(new Float32Array(position.getCount() * 2));
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, p);
      uv.setElement(i, [(p[0] - min[0]) / (max[0] - min[0]), (p[1] - min[1]) / (max[1] - min[1])]);
    }
    primitive.setAttribute('TEXCOORD_0', uv).setMaterial(glass);
  }
  part.setExtras({ aspect: (max[0] - min[0]) / (max[1] - min[1]), notch: NOTCH });
}

rebuild(lidGroup, lid, true);
rebuild(baseGroup, base, false);

// The hinge: the axis a quarter turn about which closes the lid flat on the deck with its top edge
// at the base's front edge. A real lid's hinge sits just in front of the lid, not at the barrel's
// center, and closing about the barrel left the lid raised and short of the front. Turned a quarter
// about (py, pz), a point (y, z) lands at (py + pz - z, pz - py + y): the lid's front face rests on
// the deck, a hair above it, and its top edge reaches the front edge.
const positions = (group, keep = () => true) => {
  const found = [];
  const p = [0, 0, 0];
  for (const node of group.listChildren()) {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION');
      for (let i = 0; i < position.getCount(); i++) {
        position.getElement(i, p);
        if (keep(p)) found.push([...p]);
      }
    }
  }
  return found;
};
const most = (points, axis) => Math.max(...points.map((p) => p[axis]));
const deckTop = most(positions(base), 1);
const frontEdge = most(positions(base), 2);
const lidTop = most(positions(lid), 1);
// The lid's front face, away from the hinge cover at its foot.
const lidFace = most(
  positions(lid, (p) => p[1] > 10),
  2,
);
const sum = deckTop + 0.02 + lidFace;
const difference = frontEdge - lidTop;
const pivot = [(sum - difference) / 2, (sum + difference) / 2];
for (const group of [base, lid]) {
  for (const node of group.listChildren()) {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION');
      const p = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i++) {
        position.getElement(i, p);
        position.setElement(i, [p[0], p[1] - pivot[0], p[2] - pivot[1]]);
      }
    }
  }
}
const model = document.createNode('macbook').addChild(base).addChild(lid);
for (const child of scene.listChildren()) child.dispose();
scene.addChild(model);

await document.transform(
  prune(),
  dedup(),
  weld(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
  // Reordered and quantized, but not meshopt-compressed: its decoder needs WebAssembly, which a
  // page's content security policy may refuse, and the bundled model must load on any page.
  reorder({ encoder: MeshoptEncoder }),
  quantize(),
);
await io.write(output, document);
console.log(
  `wrote ${output}: hinge at y ${pivot[0].toFixed(3)}, z ${pivot[1].toFixed(3)}; lid leaned ${(
    (lean * 180) /
    Math.PI
  ).toFixed(1)}°, display aspect ${(
    (screen.max[0] - screen.min[0]) /
    Math.hypot(screen.max[1] - screen.min[1], screen.max[2] - screen.min[2])
  ).toFixed(3)}`,
);
