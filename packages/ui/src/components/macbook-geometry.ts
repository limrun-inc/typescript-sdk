/**
 * The MacBook Pro drawn around a macOS guest. Lengths are hundredths of the screen's width, so
 * the model fits any guest display: only the screen's height, and with it the lid's height and
 * the base's depth, follows the stream's aspect ratio.
 *
 * The CSS frame (`.rc-macbook` in remote-control.css), the WebGL lid opening and the three.js
 * 3D mode all draw this one shape. Seen straight on with the lid upright, the 3D model covers
 * exactly the CSS frame, so either hands over to the other without a jump.
 */
export const MACBOOK = {
  sideBezel: 1.7,
  topBezel: 2.4,
  chin: 2.4,
  baseHeight: 2.2,
  baseOverhang: 4,
  screenRadius: 0.9,
  lidThickness: 0.7,
};
export const MACBOOK_LID_WIDTH = 100 + 2 * MACBOOK.sideBezel;
export const MACBOOK_WIDTH = MACBOOK_LID_WIDTH + 2 * MACBOOK.baseOverhang;
export const MACBOOK_EXTRA_HEIGHT = MACBOOK.topBezel + MACBOOK.chin + MACBOOK.baseHeight;
// The frame is centered in the container, and the screen sits this far above the frame's center.
export const MACBOOK_SCREEN_RAISE = (MACBOOK_EXTRA_HEIGHT - 2 * MACBOOK.topBezel) / 2;

export type MacbookPart = 'lid' | 'base';
// shell: the anodized aluminium. glass: the black glass around the screen. screen: the stream.
export type MacbookKind = 'shell' | 'glass' | 'screen' | 'camera' | 'well' | 'keys' | 'trackpad' | 'scoop';
/** Interleaved position (3), normal (3) and texture coordinate (2) per vertex, in triangles. */
export type MacbookMesh = { part: MacbookPart; kind: MacbookKind; vertices: Float32Array };
export const MACBOOK_VERTEX_FLOATS = 8;

/**
 * The model's coordinates: x to the right, y up, z toward the viewer. The hinge is the x axis.
 * Lid parts are given upright, standing on the base with the screen facing +z; turning them by
 * `macbookLidAngle` about the hinge closes the lid. The base's top is y = 0, and it reaches from
 * just behind the lid to the front edge at z = `depth`.
 */
export function macbookDimensions(aspect: number) {
  const screenHeight = 100 / aspect;
  const lidHeight = screenHeight + MACBOOK.topBezel + MACBOOK.chin;
  return {
    screenHeight,
    lidHeight,
    // A closed lid covers the base back to front.
    depth: lidHeight,
  };
}

// The lid's turn about the hinge, in radians, when closed: a quarter turn lays it on the base.
export const MACBOOK_LID_CLOSED = Math.PI / 2;
// How far the lid opens from closed, in degrees. A MacBook Pro's lid stops at about 135°, and an
// open one usually leans back a little past upright.
export const MACBOOK_LID_MAX_DEGREES = 135;
export const MACBOOK_LID_OPEN_DEGREES = 100;
// How long the lid takes to open all the way; shorter moves take their share of it.
export const MACBOOK_LID_OPENING_MS = 2400;

/** The lid's turn about the hinge, in radians, for an opening in degrees from closed. */
export function lidRotation(degrees: number) {
  return MACBOOK_LID_CLOSED - (degrees * Math.PI) / 180;
}

/** A lid's progress through a move, 0 to 1: it starts fast and slows to a stop, as one pushed does. */
export function lidEase(progress: number) {
  const t = Math.max(0, Math.min(1, progress));
  return 1 - Math.pow(1 - t, 3);
}

type Point = { x: number; y: number; nx: number; ny: number };

/** A rounded rectangle's outline, counterclockwise, with its outward normals. */
function outline(w: number, h: number, radii: { top: number; bottom: number }, segments = 6): Point[] {
  const points: Point[] = [];
  const corners = [
    [w / 2 - radii.top, h / 2 - radii.top, radii.top, 0],
    [-w / 2 + radii.top, h / 2 - radii.top, radii.top, Math.PI / 2],
    [-w / 2 + radii.bottom, -h / 2 + radii.bottom, radii.bottom, Math.PI],
    [w / 2 - radii.bottom, -h / 2 + radii.bottom, radii.bottom, Math.PI * 1.5],
  ] as const;
  for (const [cx, cy, r, start] of corners) {
    for (let j = 0; j <= segments; j++) {
      const a = start + (j * Math.PI) / 2 / segments;
      points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
    }
  }
  return points;
}

/**
 * Builds the model for a screen of the given aspect ratio. The screen's texture coordinates put
 * (0, 0) at its bottom left, as WebGL and three.js expect for an upright image.
 */
export function macbookMeshes(aspect: number): MacbookMesh[] {
  const { screenHeight, lidHeight, depth } = macbookDimensions(aspect);
  const meshes: MacbookMesh[] = [];
  const add = (part: MacbookPart, kind: MacbookKind, vertices: number[]) =>
    meshes.push({ part, kind, vertices: new Float32Array(vertices) });

  // A flat polygon fan, with texture coordinates spanning its bounds. Both renderers draw
  // two-sided, so the winding does not matter; the normal says which way the face looks.
  type Map3 = (a: number, b: number) => [number, number, number];
  const fan = (
    part: MacbookPart,
    kind: MacbookKind,
    points: { x: number; y: number }[],
    place: Map3,
    normal: [number, number, number],
  ) => {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const vertex = (a: number, b: number) => [
      ...place(a, b),
      ...normal,
      (a - minX) / (maxX - minX || 1),
      (b - minY) / (maxY - minY || 1),
    ];
    const vertices: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const q = points[(i + 1) % points.length]!;
      for (const v of [vertex(cx, cy), vertex(p.x, p.y), vertex(q.x, q.y)]) vertices.push(...v);
    }
    add(part, kind, vertices);
  };
  // A prism over an outline: its sides from `from` to `to` along the third axis.
  const sides = (
    part: MacbookPart,
    kind: MacbookKind,
    points: Point[],
    place: (a: number, b: number, c: number) => [number, number, number],
    turn: (na: number, nb: number) => [number, number, number],
    from: number,
    to: number,
  ) => {
    const vertices: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const q = points[(i + 1) % points.length]!;
      const corner = (s: Point, c: number) => [...place(s.x, s.y, c), ...turn(s.nx, s.ny), 0, 0];
      for (const v of [
        corner(p, from),
        corner(q, from),
        corner(q, to),
        corner(p, from),
        corner(q, to),
        corner(p, to),
      ])
        vertices.push(...v);
    }
    add(part, kind, vertices);
  };

  // The lid: an aluminium shell with black glass in front, upright with its bottom on the hinge.
  const lid = outline(MACBOOK_LID_WIDTH, lidHeight, { top: 2.2, bottom: 0.4 });
  const lidY = (y: number) => y + lidHeight / 2;
  const t = MACBOOK.lidThickness;
  sides(
    'lid',
    'shell',
    lid,
    (x, y, z) => [x, lidY(y), z],
    (nx, ny) => [nx, ny, 0],
    -t,
    0,
  );
  fan('lid', 'shell', lid, (x, y) => [x, lidY(y), -t], [0, 0, -1]);
  fan(
    'lid',
    'glass',
    outline(MACBOOK_LID_WIDTH - 0.5, lidHeight - 0.5, { top: 1.95, bottom: 0.2 }),
    (x, y) => [x, lidY(y), 0.01],
    [0, 0, 1],
  );
  const screenBottom = MACBOOK.chin;
  fan(
    'lid',
    'screen',
    outline(100, screenHeight, { top: MACBOOK.screenRadius, bottom: 0 }),
    (x, y) => [x, screenBottom + screenHeight / 2 + y, 0.02],
    [0, 0, 1],
  );
  fan(
    'lid',
    'camera',
    outline(0.5, 0.5, { top: 0.25, bottom: 0.25 }, 4),
    (x, y) => [x, lidHeight - MACBOOK.topBezel / 2 + y, 0.02],
    [0, 0, 1],
  );

  // The base: an aluminium slab, outlined in x and z, with the keyboard and trackpad on top.
  const base = outline(MACBOOK_WIDTH, depth + t, { top: 3, bottom: 3 });
  // Outline y runs toward the back here, so the slab's front edge (outline y < 0) faces the viewer.
  const baseZ = (y: number) => (depth - t) / 2 - y;
  sides(
    'base',
    'shell',
    base,
    (x, y, h) => [x, h, baseZ(y)],
    (nx, ny) => [nx, 0, -ny],
    -MACBOOK.baseHeight,
    0,
  );
  fan('base', 'shell', base, (x, y) => [x, 0, baseZ(y)], [0, 1, 0]);
  fan('base', 'shell', base, (x, y) => [x, -MACBOOK.baseHeight, baseZ(y)], [0, -1, 0]);
  // A rounded plate lying on the base's top, centered at (x, z).
  const deck = (kind: MacbookKind, x: number, z: number, w: number, d: number, lift: number, r: number) =>
    fan('base', kind, outline(w, d, { top: r, bottom: r }, 3), (a, b) => [x + a, lift, z - b], [0, 1, 0]);
  // The keyboard well with six rows of keys, the top one the half-height function row.
  const keysWidth = MACBOOK_WIDTH * 0.72;
  const wellTop = depth * 0.08;
  const rows = [0.55, 1, 1, 1, 1, 1];
  const rowUnit = (depth * 0.4) / rows.reduce((sum, r) => sum + r, 0);
  deck('well', 0, wellTop + (depth * 0.4) / 2, keysWidth + 1.4, depth * 0.4 + 1.4, 0.01, 0.8);
  let rowZ = wellTop;
  for (const [index, row] of rows.entries()) {
    const height = row * rowUnit;
    const pitch = keysWidth / 14;
    for (let k = 0; k < 14; k++) {
      // The bottom row's space bar takes five keys' width.
      if (index === 5 && k > 4 && k < 9) continue;
      const wide = index === 5 && k === 4 ? 5 : 1;
      deck(
        'keys',
        -keysWidth / 2 + pitch * (k + wide / 2),
        rowZ + height / 2,
        pitch * wide - 0.5,
        height - 0.5,
        0.03,
        0.3,
      );
    }
    rowZ += height;
  }
  deck('trackpad', 0, depth * 0.72, MACBOOK_WIDTH * 0.4, depth * 0.36, 0.01, 1.2);

  // The thumb scoop in the front edge that lifts the lid.
  fan(
    'base',
    'scoop',
    outline(14, 0.9, { top: 0, bottom: 0.45 }, 3),
    (x, y) => [x, -0.45 + y, depth + 0.01],
    [0, 0, 1],
  );

  // One mesh per part and kind, so each renderer draws a material once.
  const merged = new Map<string, MacbookMesh[]>();
  for (const mesh of meshes) {
    const key = `${mesh.part}:${mesh.kind}`;
    merged.set(key, [...(merged.get(key) ?? []), mesh]);
  }
  return [...merged.values()].map((group) => {
    const vertices = new Float32Array(group.reduce((sum, mesh) => sum + mesh.vertices.length, 0));
    let offset = 0;
    for (const mesh of group) {
      vertices.set(mesh.vertices, offset);
      offset += mesh.vertices.length;
    }
    return { part: group[0]!.part, kind: group[0]!.kind, vertices };
  });
}

/**
 * How a stream fills a display of another shape: the texture transform that keeps its shape,
 * centered, with black bars on the sides it does not reach. Texture coordinates outside 0 to 1
 * after it are the bars. A display with a notch keeps the stream below it, in the band macOS keeps
 * clear of the notch; `notch` is the share of the display's height the notch takes at its top.
 */
export function streamFit(videoAspect: number, screenAspect: number, notch = 0) {
  const area = 1 - notch;
  const areaAspect = screenAspect / area;
  const width = videoAspect >= areaAspect ? 1 : videoAspect / areaAspect;
  const height = (videoAspect >= areaAspect ? areaAspect / videoAspect : 1) * area;
  const left = (1 - width) / 2;
  const bottom = (area - height) / 2;
  return { repeat: [1 / width, 1 / height], offset: [(0 - left) / width, (0 - bottom) / height] } as const;
}

/**
 * The stream's point, 0 to 1 from its top left, at a point of the display given as texture
 * coordinates from its bottom left; undefined on a black bar.
 */
export function streamPoint(
  u: number,
  v: number,
  fit: { repeat: readonly number[]; offset: readonly number[] },
): { x: number; y: number } | undefined {
  const x = u * fit.repeat[0]! + fit.offset[0]!;
  const y = v * fit.repeat[1]! + fit.offset[1]!;
  // A point on the stream's edge may land a rounding error past it.
  const edge = 1e-9;
  if (x < -edge || x > 1 + edge || y < -edge || y > 1 + edge) return undefined;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return { x: clamp(x), y: clamp(1 - y) };
}
