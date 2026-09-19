import * as THREE from 'three';
import type { DuoButton } from '../core/duo';

type Edge = 'top' | 'bottom' | 'left' | 'right';
export type HardwareGuide = { button: DuoButton; edge: Edge; x: number; y: number };

/** Keep button hints outside the silhouette as the device folds, rotates and changes size. */
export function hardwareLayout(
  anchors: { button: DuoButton; point: THREE.Vector3; outward: THREE.Vector3 }[],
  bounds: THREE.Box3,
  camera: THREE.Camera,
  width: number,
  height: number,
) {
  const project = (point: THREE.Vector3) => {
    const p = point.clone().project(camera);
    return new THREE.Vector2(((p.x + 1) * width) / 2, ((1 - p.y) * height) / 2);
  };
  const rect = new THREE.Box2();
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) rect.expandByPoint(project(new THREE.Vector3(x, y, z)));
  const guides: HardwareGuide[] = anchors.map(({ button, point, outward }) => {
    const p = project(point);
    const d = project(outward).sub(p);
    const vertical = Math.abs(d.y) >= Math.abs(d.x);
    const edge: Edge =
      vertical ?
        d.y < 0 ?
          'top'
        : 'bottom'
      : d.x < 0 ? 'left'
      : 'right';
    return {
      button,
      edge,
      x:
        vertical ? p.x
        : edge === 'left' ? rect.min.x - 28
        : rect.max.x + 28,
      y:
        !vertical ? p.y
        : edge === 'top' ? rect.min.y - 28
        : rect.max.y + 28,
    };
  });
  const volume = guides.filter((guide) => guide.button !== 'side');
  if (volume.length === 2 && volume[0]!.edge === volume[1]!.edge) {
    const axis = volume[0]!.edge === 'top' || volume[0]!.edge === 'bottom' ? 'x' : 'y';
    volume.sort((a, b) => a[axis] - b[axis]);
    if (volume[1]![axis] - volume[0]![axis] < 48) {
      const center = (volume[0]![axis] + volume[1]![axis]) / 2;
      volume[0]![axis] = center - 24;
      volume[1]![axis] = center + 24;
    }
  }
  return { guides, rect };
}

export { flatHoverEdge as hardwareHoverEdge } from './duo-flat-geometry';
