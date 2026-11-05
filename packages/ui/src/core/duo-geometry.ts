import { DUO_DIMENSIONS } from './duo';

/** Physical dimensions in millimeters, shared by native video, folding and the 3D model. */
export const DUO_GEOMETRY = {
  body: { ...DUO_DIMENSIONS, edgeExpansion: 0.2, radius: 8.6, foldRadius: 0.55, closedDepth: 11.3 },
  inner: { width: 157.5, height: 110.8, radius: 5.3, bendHalfWidth: 1.1, z: 0.14 },
  outer: { width: 77.1, height: 112.2, foldRadius: 0.8, radius: 6.6 },
} as const;

/** Extrusion bevels extend beyond the nominal outline on both sides. */
export function duoBodySize(inner: boolean) {
  const { body } = DUO_GEOMETRY;
  return {
    width: body.width / (inner ? 1 : 2) + 2 * body.edgeExpansion,
    height: body.height + 2 * body.edgeExpansion,
  };
}

/** Reserve the same space for hardware controls in either rendering mode. */
export function duoFitScale(bodyWidth: number, bodyHeight: number, width: number, height: number) {
  return Math.max(0, Math.min((width - 120) / bodyWidth, (height - 120) / bodyHeight));
}

export function duoScreenRadii(inner: boolean, scale: number) {
  const { inner: inside, outer } = DUO_GEOMETRY;
  return (
    inner ?
      [inside.radius, inside.radius, inside.radius, inside.radius]
    : [outer.foldRadius, outer.radius, outer.radius, outer.foldRadius])
    .map((r) => `${r * scale}px`)
    .join(' ');
}
