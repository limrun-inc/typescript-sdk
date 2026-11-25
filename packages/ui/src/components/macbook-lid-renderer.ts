/** A small WebGL MacBook used only while its lid opens, so the opening needs no 3D library. */
import {
  MACBOOK,
  MACBOOK_VERTEX_FLOATS,
  macbookDimensions,
  macbookMeshes,
  type MacbookKind,
} from './macbook-geometry';

export const LID_OPEN_DURATION = 1600;

export type LidOpening = {
  /** The stream, drawn live on the screen once it has a frame. */
  video: HTMLVideoElement | null;
  /** The screen's aspect ratio, which the stream sets. */
  aspect: number;
  /** CSS pixels per hundredth of the screen's width, as the CSS frame is laid out. */
  unit: number;
  /** How far below the container's center the CSS frame's center sits, in CSS pixels. */
  shift: number;
};

const KINDS: MacbookKind[] = ['shell', 'glass', 'screen', 'camera', 'well', 'keys', 'trackpad', 'scoop'];

/** The lid turns up first; the view drops from above the keyboard to straight on as it does. */
export function lidPose(progress: number) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const lid = ease(clamp((progress - 0.06) / 0.8));
  const view = ease(clamp((progress - 0.3) / 0.7));
  return { angle: (Math.PI / 2) * (1 - lid), pitch: 0.42 * (1 - view) };
}

const vertexShader = `
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform vec2 viewport;
uniform float unit;
uniform float shift;
uniform float lid;
uniform vec2 hinge;
uniform vec2 view;
uniform vec2 pivot;
uniform float lift;
varying vec3 worldNormal;
varying vec2 texcoord;
void main() {
  vec3 p = position;
  vec3 n = normal;
  if (lid > 0.5) {
    p.yz = vec2(p.y * hinge.x - p.z * hinge.y, p.y * hinge.y + p.z * hinge.x);
    n.yz = vec2(n.y * hinge.x - n.z * hinge.y, n.y * hinge.y + n.z * hinge.x);
  }
  p.yz -= pivot;
  p.yz = vec2(p.y * view.x - p.z * view.y, p.y * view.y + p.z * view.x);
  n.yz = vec2(n.y * view.x - n.z * view.y, n.y * view.y + n.z * view.x);
  p.y += lift;
  worldNormal = n;
  texcoord = uv;
  vec2 pixel = vec2(p.x * unit, p.y * unit - shift);
  gl_Position = vec4(pixel * 2.0 / viewport, -p.z / 400.0, 1.0);
}`;

// Kinds: 0 shell, 1 glass, 2 screen, 3 camera, 4 well, 5 keys, 6 trackpad, 7 scoop.
const fragmentShader = `
precision highp float;
uniform int kind;
uniform int live;
uniform sampler2D screen;
varying vec3 worldNormal;
varying vec2 texcoord;
void main() {
  if (kind == 2 && live == 1) { gl_FragColor = texture2D(screen, texcoord); return; }
  vec3 n = normalize(worldNormal);
  vec3 light = normalize(vec3(-0.3, 0.8, 0.6));
  vec3 halfway = normalize(light + vec3(0.0, 0.0, 1.0));
  float diffuse = max(dot(n, light), 0.0);
  float glint = pow(max(dot(n, halfway), 0.0), 60.0);
  // Broad studio strips in the metal's reflection, as on the iPhone Duo's frame.
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  float strip = pow(0.5 + 0.5 * sin(4.0 * atan(r.z, r.x) + 1.8 * asin(clamp(r.y, -1.0, 1.0))), 10.0);
  vec3 color;
  if (kind == 0) color = vec3(0.09, 0.09, 0.1) + vec3(0.1) * diffuse + vec3(0.16) * strip + vec3(0.3) * glint;
  else if (kind == 1 || kind == 2) color = vec3(0.012, 0.012, 0.015) + vec3(0.25) * glint;
  else if (kind == 3) color = vec3(0.05, 0.06, 0.07);
  else if (kind == 4) color = vec3(0.05, 0.05, 0.055) + vec3(0.04) * diffuse;
  else if (kind == 5) color = vec3(0.02, 0.02, 0.022) + vec3(0.05) * diffuse;
  else if (kind == 6) color = vec3(0.12, 0.12, 0.13) + vec3(0.12) * diffuse + vec3(0.25) * glint;
  else color = vec3(0.06, 0.06, 0.065);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

/** The renderer owns its context, buffers and texture, and releases all of them after one opening. */
export function renderLidOpening(canvas: HTMLCanvasElement, opening: LidOpening, finished: () => void) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'low-power' });
  if (!gl) throw new Error('Lid animation WebGL unavailable');
  const shaders: WebGLShader[] = [];
  const buffers: WebGLBuffer[] = [];
  let texture: WebGLTexture | null = null;
  let program: WebGLProgram | null = null;
  let animation = 0;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animation);
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    if (texture) gl.deleteTexture(texture);
    for (const shader of shaders) gl.deleteShader(shader);
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
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Lid shader compilation failed');
    }
    program = gl.createProgram()!;
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Lid shader link failed');
    gl.useProgram(program);
    const uniforms = Object.fromEntries(
      ['viewport', 'unit', 'shift', 'lid', 'hinge', 'view', 'pivot', 'lift', 'kind', 'live', 'screen'].map(
        (name) => [name, gl.getUniformLocation(program!, name)],
      ),
    );

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms['viewport']!, width, height);
    gl.uniform1f(uniforms['unit']!, opening.unit);
    gl.uniform1f(uniforms['shift']!, opening.shift);
    const { centerY, depth } = macbookDimensions(opening.aspect);
    // The view turns about the model's middle, which stays at the frame's center throughout.
    gl.uniform2f(uniforms['pivot']!, centerY, depth / 2);
    gl.uniform1i(uniforms['screen']!, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    for (const [parameter, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, parameter!, value!);

    const attributes = ['position', 'normal', 'uv'].map((name) => gl.getAttribLocation(program!, name));
    const stride = MACBOOK_VERTEX_FLOATS * 4;
    const meshes = macbookMeshes(opening.aspect).map((mesh) => {
      const buffer = gl.createBuffer()!;
      buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      return { ...mesh, buffer, count: mesh.vertices.length / MACBOOK_VERTEX_FLOATS };
    });

    const start = performance.now();
    const render = (time: number) => {
      if (disposed) return;
      const progress = Math.min(1, (time - start) / LID_OPEN_DURATION);
      const { angle, pitch } = lidPose(progress);
      const video = opening.video;
      const live = !!video && video.readyState >= 2 && video.videoWidth > 0;
      if (live) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        } catch {
          // A frame the browser cannot upload leaves the screen dark for this tick.
        }
      }
      gl.uniform1i(uniforms['live']!, live ? 1 : 0);
      gl.uniform2f(uniforms['hinge']!, Math.cos(angle), Math.sin(angle));
      gl.uniform2f(uniforms['view']!, Math.cos(pitch), Math.sin(pitch));
      // A closed MacBook is only its base's height, so it rises to the frame's center as it opens.
      gl.uniform1f(
        uniforms['lift']!,
        (centerY + MACBOOK.baseHeight / 2) * (angle / (Math.PI / 2)) * Math.cos(pitch),
      );
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      for (const mesh of meshes) {
        gl.uniform1f(uniforms['lid']!, mesh.part === 'lid' ? 1 : 0);
        gl.uniform1i(uniforms['kind']!, KINDS.indexOf(mesh.kind));
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
        for (let i = 0; i < attributes.length; i++) {
          if (attributes[i]! < 0) continue;
          gl.enableVertexAttribArray(attributes[i]!);
          gl.vertexAttribPointer(attributes[i]!, i === 2 ? 2 : 3, gl.FLOAT, false, stride, i * 12);
        }
        gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      }
      if (progress < 1) animation = requestAnimationFrame(render);
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
