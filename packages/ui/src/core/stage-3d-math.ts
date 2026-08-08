// Math for the 3D device stage.
//
// The stage element is rendered with the CSS transform
//
//   perspective(P) rotateX(a) rotateY(b)
//
// around its center (default `transform-origin`). CSS applies the functions
// left-to-right to a point, i.e. a stage-local point q = (u, v, 0) ends up at
//
//   p = Rx(a) · Ry(b) · q            (rotation)
//   screen = (p.x, p.y) · P / (P - p.z)   (perspective divide, eye at (0,0,P))
//
// with x pointing right, y pointing down, and z toward the viewer.
//
// Pointer events arrive in screen space, but touch injection needs the
// position on the (untransformed) device surface. `unprojectPoint` inverts
// the mapping exactly by casting a ray from the eye through the screen point
// and intersecting it with the rotated stage plane, so taps stay
// pixel-accurate even while the device is tilted.

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

const DEG2RAD = Math.PI / 180;

type RotationBasis = {
  // Columns of R = Rx(a)·Ry(b): images of the local x/y/z axes.
  xAxis: Vec3;
  yAxis: Vec3;
  normal: Vec3;
};

export const rotationBasis = (rotateXDeg: number, rotateYDeg: number): RotationBasis => {
  const a = rotateXDeg * DEG2RAD;
  const b = rotateYDeg * DEG2RAD;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  return {
    xAxis: { x: cb, y: sa * sb, z: -ca * sb },
    yAxis: { x: 0, y: ca, z: sa },
    normal: { x: sb, y: -sa * cb, z: ca * cb },
  };
};

// z-component of the rotated surface normal. Positive means the screen face
// points toward the viewer; negative means we're looking at the back.
export const facing = (rotateXDeg: number, rotateYDeg: number): number =>
  Math.cos(rotateXDeg * DEG2RAD) * Math.cos(rotateYDeg * DEG2RAD);

// Forward projection of a stage-local point (relative to the transform
// origin) into screen space (also relative to the origin). Returns null for
// points behind the eye. Used by tests to validate the inverse.
export const projectPoint = (
  rotateXDeg: number,
  rotateYDeg: number,
  perspective: number,
  u: number,
  v: number,
): Vec2 | null => {
  const { xAxis, yAxis } = rotationBasis(rotateXDeg, rotateYDeg);
  const p: Vec3 = {
    x: xAxis.x * u + yAxis.x * v,
    y: xAxis.y * u + yAxis.y * v,
    z: xAxis.z * u + yAxis.z * v,
  };
  const w = perspective - p.z;
  if (w <= 0) return null;
  const scale = perspective / w;
  return { x: p.x * scale, y: p.y * scale };
};

// Inverse projection: given a screen point (relative to the transform
// origin), returns the stage-local point that renders there, or null when
// the ray misses the front of the surface (grazing angles / backside).
export const unprojectPoint = (
  rotateXDeg: number,
  rotateYDeg: number,
  perspective: number,
  screenX: number,
  screenY: number,
): Vec2 | null => {
  const { xAxis, yAxis, normal } = rotationBasis(rotateXDeg, rotateYDeg);

  // The viewer sees the back of the surface: there is no meaningful screen
  // position to map to.
  if (normal.z <= 1e-6) return null;

  // Ray from the eye E = (0, 0, P) through S = (screenX, screenY, 0),
  // intersected with the plane { X : normal · X = 0 }.
  const denominator = normal.z * perspective - normal.x * screenX - normal.y * screenY;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = (normal.z * perspective) / denominator;
  // t <= 0 means the intersection is behind the eye; t is unbounded near
  // grazing angles where input mapping is meaningless anyway.
  if (t <= 0 || !Number.isFinite(t)) return null;

  const X: Vec3 = { x: screenX * t, y: screenY * t, z: perspective * (1 - t) };
  return {
    x: xAxis.x * X.x + xAxis.y * X.y + xAxis.z * X.z,
    y: yAxis.x * X.x + yAxis.y * X.y + yAxis.z * X.z,
  };
};
