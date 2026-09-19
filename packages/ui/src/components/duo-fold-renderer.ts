/** A small WebGL model used only while the otherwise-flat device folds. */
import type { FoldMotion } from './duo-fold-motion';

export const FOLD_DURATION = 1200;
const HALF = 82.3;
const HEIGHT = 117.8;
const DEPTH = 5.2;
const PIVOT = 0.6;
type Kind = 'metal' | 'seal' | 'inner' | 'outer' | 'back';
export type FoldMesh = { side: -1 | 0 | 1; kind: Kind; vertices: Float32Array };
type Point = { x: number; y: number; nx: number; ny: number };

function perimeter(w: number, h: number, left: number, right: number, inset = 0): Point[] {
  const points: Point[] = [];
  for (const [cx, cy, r, start] of [
    [w / 2 - right, h / 2 - right, right, 0],
    [-w / 2 + left, h / 2 - left, left, Math.PI / 2],
    [-w / 2 + left, -h / 2 + left, left, Math.PI],
    [w / 2 - right, -h / 2 + right, right, Math.PI * 1.5],
  ]) {
    for (let j = 0; j <= 8; j++) {
      const a = start! + (j * Math.PI) / 16;
      const nx = Math.cos(a),
        ny = Math.sin(a);
      points.push({ x: cx! + (r! - inset) * nx, y: cy! + (r! - inset) * ny, nx, ny });
    }
  }
  return points;
}

/** Low-segment beveled rails, three caps, glass seals and three screen polygons. */
export function foldMeshes(): FoldMesh[] {
  const meshes: FoldMesh[] = [];
  const add = (side: -1 | 0 | 1, kind: Kind, vertices: number[]) =>
    meshes.push({ side, kind, vertices: new Float32Array(vertices) });
  const plate = (
    side: -1 | 1,
    kind: Kind,
    cx: number,
    cy: number,
    w: number,
    h: number,
    front: number,
    depth: number,
    left: number,
    right: number,
  ) => {
    const vertices: number[] = [];
    const append = (p: Point, z: number, nz: number, radial: number) =>
      vertices.push(p.x + cx, p.y + cy, z, p.nx * radial, p.ny * radial, nz, 0, 0);
    const bevel = Math.min(0.32, depth / 3, left / 2, right / 2);
    const rings = [
      [bevel, front, 0.707, 0.707],
      [0, front - bevel, 0, 1],
      [0, front - depth + bevel, 0, 1],
      [bevel, front - depth, -0.707, 0.707],
    ];
    for (let k = 0; k < rings.length - 1; k++) {
      const a = rings[k]!,
        b = rings[k + 1]!;
      const pa = perimeter(w, h, left, right, a[0]);
      const pb = perimeter(w, h, left, right, b[0]);
      for (let i = 0; i < pa.length; i++) {
        const n = (i + 1) % pa.length;
        for (const [p, ring] of [
          [pa[i]!, a],
          [pb[i]!, b],
          [pa[n]!, a],
          [pa[n]!, a],
          [pb[i]!, b],
          [pb[n]!, b],
        ] as const)
          append(p, ring[1]!, ring[2]!, ring[3]!);
      }
    }
    const rim = perimeter(w, h, left, right, bevel);
    for (const [z, nz] of [
      [front, 1],
      [front - depth, -1],
    ]) {
      for (let i = 0; i < rim.length; i++) {
        vertices.push(cx, cy, z!, 0, 0, nz!, 0, 0);
        append(rim[i]!, z!, nz!, 0);
        append(rim[(i + 1) % rim.length]!, z!, nz!, 0);
      }
    }
    add(side, kind, vertices);
  };
  const face = (
    side: -1 | 1,
    kind: Kind,
    cx: number,
    w: number,
    h: number,
    z: number,
    left: number,
    right: number,
  ) => {
    const vertices: number[] = [];
    const rim = perimeter(w, h, left, right);
    const append = (x: number, y: number) => {
      const px = x + cx;
      let u = 0,
        v = 0;
      if (kind === 'inner') {
        u = 0.5 - y / 110.8;
        v = 0.5 + px / 157.5;
      }
      if (kind === 'outer') {
        u = 0.5 - x / w;
        v = 0.5 + y / h;
      }
      vertices.push(px, y, z, 0, 0, kind === 'outer' || kind === 'back' ? -1 : 1, u, v);
    };
    for (let i = 0; i < rim.length; i++) {
      append(0, 0);
      append(rim[i]!.x, rim[i]!.y);
      append(rim[(i + 1) % rim.length]!.x, rim[(i + 1) % rim.length]!.y);
    }
    add(side, kind, vertices);
  };
  for (const side of [-1, 1] as const) {
    const left = side === -1 ? 8.4 : 1.25;
    const right = side === 1 ? 8.4 : 1.25;
    plate(side, 'metal', (side * HALF) / 2, 0, HALF, HEIGHT, 0, DEPTH, left, right);
    face(
      side,
      'seal',
      (side * HALF) / 2,
      HALF - 2.24,
      HEIGHT - 2.24,
      0.12,
      side === -1 ? 7.15 : 0.2,
      side === 1 ? 7.15 : 0.2,
    );
    face(
      side,
      'inner',
      side * (157.5 / 4 + 0.55),
      157.5 / 2 - 1.1,
      110.8,
      0.24,
      side === -1 ? 5.3 : 0,
      side === 1 ? 5.3 : 0,
    );
  }
  for (const [kind, h, z] of [
    ['metal', HEIGHT, -0.12],
    ['seal', HEIGHT - 2.24, 0.12],
    ['inner', 110.8, 0.24],
  ] as const) {
    const hinge: number[] = [];
    const point = (x: number, y: number) => hinge.push(x, y, z, 0, 0, 1, 0.5 - y / 110.8, 0.5 + x / 157.5);
    for (let i = 0; i < 6; i++) {
      const a = -1.1 + (i * 2.2) / 6,
        b = a + 2.2 / 6;
      for (const [x, y] of [
        [a, -h / 2],
        [b, -h / 2],
        [a, h / 2],
        [a, h / 2],
        [b, -h / 2],
        [b, h / 2],
      ])
        point(x!, y!);
    }
    add(0, kind, hinge);
  }
  face(-1, 'seal', -HALF / 2, HALF - 2.24, HEIGHT - 2.24, -DEPTH - 0.12, 7.15, 0.65);
  face(-1, 'outer', -HALF / 2, 77.1, 112.2, -DEPTH - 0.24, 6.6, 0.8);
  face(1, 'back', HALF / 2, HALF - 1, HEIGHT - 1, -DEPTH - 0.12, 0.8, 8);
  for (const x of [HALF - 37, HALF - 25])
    plate(1, 'metal', x, HEIGHT / 2 + 0.4, 9.5, 0.8, -1.4, 2, 0.35, 0.35);
  plate(1, 'metal', HALF + 0.4, 21, 0.8, 13, -1.4, 2, 0.35, 0.35);
  return meshes;
}

/** Both leaves turn toward the viewer before settling flat, following the reference's shallow V. */
export function foldPose(progress: number) {
  const keys = [
    [0, 180, 0, -0.5],
    [0.12, 176, -4, -0.46],
    [0.24, 150, -8, -0.4],
    [0.35, 90, -12, -0.32],
    [0.48, 48, -22, -0.14],
    [0.62, 30, -20, -0.04],
    [0.8, 14, -10, 0],
    [1, 0, 0, 0],
  ];
  const p = Math.max(0, Math.min(1, progress));
  const i = Math.max(0, keys.findIndex((key) => key[0]! >= p) - 1);
  const a = keys[i]!,
    b = keys[i + 1]!;
  const t = Math.max(0, Math.min(1, (p - a[0]!) / (b[0]! - a[0]!)));
  const blend = (n: number) => a[n]! + (b[n]! - a[n]!) * t;
  return { left: (blend(1) * Math.PI) / 180, right: (blend(2) * Math.PI) / 180, shift: blend(3) * HALF };
}

const vertexShader = `
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform vec2 viewport;
uniform float scale;
uniform vec2 leaf;
uniform vec2 roll;
uniform vec4 hinge;
uniform int bend;
uniform float shift;
uniform float level;
varying vec3 worldPosition;
varying vec3 worldNormal;
varying vec2 texcoord;
void main() {
  vec3 p = position - vec3(0.,0.,${PIVOT});
  p = vec3(leaf.x*p.x + leaf.y*p.z, p.y, -leaf.y*p.x + leaf.x*p.z);
  if (bend==1) {
    vec2 a=vec2(-1.1*hinge.x+(position.z-${PIVOT})*hinge.y,1.1*hinge.y+(position.z-${PIVOT})*hinge.x);
    vec2 b=vec2(1.1*hinge.z+(position.z-${PIVOT})*hinge.w,-1.1*hinge.w+(position.z-${PIVOT})*hinge.z);
    p.xz=mix(a,b,(position.x+1.1)/2.2);
  }
  p += vec3(shift,0.,${PIVOT});
  vec3 n = vec3(leaf.x*normal.x + leaf.y*normal.z, normal.y, -leaf.y*normal.x + leaf.x*normal.z);
  p.xy = vec2(roll.x*p.x-roll.y*p.y, roll.y*p.x+roll.x*p.y);
  n.xy = vec2(roll.x*n.x-roll.y*n.y, roll.y*n.x+roll.x*n.y);
  p.z -= level;
  worldPosition=p; worldNormal=n; texcoord=uv;
  float w = 1. - p.z/600.;
  gl_Position=vec4(p.xy*scale*2./viewport, -p.z/180., w);
}`;
const fragmentShader = `
precision highp float;
uniform int kind;
uniform sampler2D screen;
varying vec3 worldPosition;
varying vec3 worldNormal;
varying vec2 texcoord;
void main() {
  if (kind==2) { gl_FragColor=texture2D(screen,texcoord); return; }
  vec3 n=normalize(worldNormal);
  vec3 eye=normalize(vec3(0.,0.,600.)-worldPosition);
  vec3 r=normalize(reflect(-eye,n)+worldPosition/190.);
  float longitude=atan(r.z,r.x);
  float latitude=asin(clamp(r.y,-1.,1.));
  float strip=pow(.5+.5*sin(4.*longitude+1.8*sin(latitude)),12.);
  float fill=pow(.5+.5*cos(2.*longitude-3.*latitude),5.);
  float highlight=pow(max(0.,dot(n,normalize(vec3(-.4,.65,1.)))),90.);
  vec3 silver=vec3(.30,.32,.34)+vec3(.85,.86,.87)*strip+vec3(.48)*fill+vec3(.7)*highlight;
  if(kind==1) silver=vec3(.022,.026,.030)+silver*.035;
  if(kind==3) silver=vec3(.93,.93,.91)*(0.88+.12*max(n.z,0.));
  gl_FragColor=vec4(clamp(silver,0.,1.),1.);
}`;

/** The renderer owns its context, buffers and textures, and releases all of them after one fold. */
export function renderFold(canvas: HTMLCanvasElement, motion: FoldMotion, finished: () => void) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'low-power' });
  if (!gl) throw new Error('Fold animation WebGL unavailable');
  const shaders: WebGLShader[] = [];
  const buffers: WebGLBuffer[] = [];
  const textures: WebGLTexture[] = [];
  let program: WebGLProgram | null = null;
  let animation = 0;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animation);
    for (const resource of buffers) gl.deleteBuffer(resource);
    for (const resource of textures) gl.deleteTexture(resource);
    for (const resource of shaders) gl.deleteShader(resource);
    if (program) gl.deleteProgram(program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexShader],
      [gl.FRAGMENT_SHADER, fragmentShader],
    ] as const) {
      const shader = gl.createShader(type)!;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error('Fold shader compilation failed');
    }
    program = gl.createProgram()!;
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Fold shader link failed');
    gl.useProgram(program);
    const location = (name: string) => gl.getUniformLocation(program!, name);
    const uniforms = Object.fromEntries(
      ['viewport', 'scale', 'leaf', 'roll', 'shift', 'level', 'kind', 'screen', 'hinge', 'bend'].map((n) => [
        n,
        location(n),
      ]),
    );
    const opening = motion.to.inner;
    const opened = opening ? motion.to : motion.from;
    const closed = opening ? motion.from : motion.to;
    const width = opened.frame.rect.min.x + opened.frame.rect.max.x;
    const height = opened.frame.rect.min.y + opened.frame.rect.max.y;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5, 1280 / Math.max(width, height));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms['viewport']!, width, height);
    gl.uniform1i(uniforms['screen']!, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    const images = {
      inner: opening ? motion.after! : motion.before,
      outer: opening ? motion.before : motion.after!,
    };
    const maps = {} as Record<'inner' | 'outer', WebGLTexture>;
    for (const kind of ['inner', 'outer'] as const) {
      const texture = gl.createTexture()!;
      textures.push(texture);
      maps[kind] = texture;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[kind]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const attributes = ['position', 'normal', 'uv'].map((name) => gl.getAttribLocation(program!, name));
    const meshes = foldMeshes().map((mesh) => {
      const buffer = gl.createBuffer()!;
      buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      return { ...mesh, buffer };
    });
    const start = performance.now();
    const rollFrom = (closed.frame.turns * -Math.PI) / 2;
    const rollDelta =
      (((opened.frame.turns * -Math.PI) / 2 - rollFrom + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    let lastRender = -Infinity;
    const render = (time: number) => {
      if (disposed) return;
      if (time - lastRender < 1000 / 60 - 0.5 && time - start < FOLD_DURATION) {
        animation = requestAnimationFrame(render);
        return;
      }
      lastRender = time;
      const elapsed = Math.min(1, (time - start) / FOLD_DURATION);
      const p = opening ? elapsed : 1 - elapsed;
      const pose = foldPose(p);
      const fit = p * p * (3 - 2 * p);
      const roll = rollFrom + rollDelta * fit;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(uniforms['scale']!, closed.frame.scale + (opened.frame.scale - closed.frame.scale) * fit);
      gl.uniform2f(uniforms['roll']!, Math.cos(roll), Math.sin(roll));
      gl.uniform1f(uniforms['shift']!, pose.shift);
      gl.uniform1f(uniforms['level']!, (DEPTH + PIVOT * 2 + 0.24) * (1 - fit));
      gl.uniform4f(
        uniforms['hinge']!,
        Math.cos(pose.left),
        Math.sin(pose.left),
        Math.cos(pose.right),
        Math.sin(pose.right),
      );
      for (const mesh of meshes) {
        gl.uniform1i(uniforms['bend']!, mesh.side === 0 ? 1 : 0);
        const angle = mesh.side === -1 ? pose.left : pose.right;
        gl.uniform2f(uniforms['leaf']!, Math.cos(angle), Math.sin(angle));
        const textured = mesh.kind === 'inner' || mesh.kind === 'outer';
        gl.uniform1i(
          uniforms['kind']!,
          textured ? 2
          : mesh.kind === 'metal' ? 0
          : mesh.kind === 'seal' ? 1
          : 3,
        );
        if (textured) gl.bindTexture(gl.TEXTURE_2D, maps[mesh.kind as 'inner' | 'outer']);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
        for (let i = 0; i < attributes.length; i++) {
          gl.enableVertexAttribArray(attributes[i]!);
          gl.vertexAttribPointer(attributes[i]!, i === 2 ? 2 : 3, gl.FLOAT, false, 32, i === 2 ? 24 : i * 12);
        }
        gl.drawArrays(gl.TRIANGLES, 0, mesh.vertices.length / 8);
      }
      if (elapsed < 1) animation = requestAnimationFrame(render);
      else {
        dispose();
        finished();
      }
    };
    render(start);
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
