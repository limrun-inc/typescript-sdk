import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createDuoModel } from './duo-model';
import { panelTouch } from '../core/duo';

function rayAt(model: ReturnType<typeof createDuoModel>, name: string) {
  const panel = model.device.getObjectByName(name)!;
  const point = panel.localToWorld(new THREE.Vector3());
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(panel.matrixWorld);
  return new THREE.Raycaster(point.clone().addScaledVector(normal, 80), normal.negate()).intersectObjects(
    model.hitObjects,
    false,
  )[0];
}

describe('Duo display geometry', () => {
  it.each([110, 180])('preserves native touch UVs on both inner leaves at %s°', (angle) => {
    const model = createDuoModel(new THREE.Texture(), new THREE.Texture());
    model.setAngle(angle);
    for (const side of [0, 1]) {
      const hit = rayAt(model, `inner-display-${side}`)!;
      expect(hit.object.userData['display']).toBe('inner');
      const point = panelTouch(hit.uv!.x, hit.uv!.y);
      expect(point.x).toBeCloseTo(0.5);
      expect(point.y).toBeCloseTo(side === 0 ? 0.7535 : 0.2465, 3);
    }
    model.dispose();
  });
  it('exposes the cover when folded and leaves the native image upright', () => {
    const model = createDuoModel(new THREE.Texture(), new THREE.Texture());
    model.setAngle(0);
    model.device.rotation.y = Math.PI / 2;
    model.device.updateMatrixWorld(true);
    const hit = rayAt(model, 'cover-display')!;
    expect(hit.object.name).toBe('cover-display');
    const point = panelTouch(hit.uv!.x, hit.uv!.y);
    expect(point.x).toBeCloseTo(0.5);
    expect(point.y).toBeCloseTo(0.5);
    model.dispose();
  });
  it.each([0, 45, 90, 110, 180])(
    'has finite bounds and a continuous display across the fold at %s°',
    (angle) => {
      const model = createDuoModel(new THREE.Texture(), new THREE.Texture());
      model.setAngle(angle);
      const displays = model.hitObjects.filter((o) => o.userData['display'] === 'inner') as THREE.Mesh[];
      const bend = displays.find((o) => o.name === '')!;
      const bendPositions = bend.geometry.getAttribute('position');
      for (const [side, vertex] of [
        [0, 0],
        [1, bendPositions.count - 2],
      ]) {
        const panel = model.device.getObjectByName(`inner-display-${side}`) as THREE.Mesh;
        const vertices = panel.geometry.getAttribute('position');
        const edge = new THREE.Vector3().fromBufferAttribute(bendPositions, vertex!);
        const distances = Array.from({ length: vertices.count }, (_, i) =>
          panel.localToWorld(new THREE.Vector3().fromBufferAttribute(vertices, i)).distanceTo(edge),
        );
        expect(Math.min(...distances)).toBeLessThan(0.0001);
      }
      const size = new THREE.Box3().setFromObject(model.device).getSize(new THREE.Vector3());
      expect(size.toArray().every(Number.isFinite)).toBe(true);
      expect(Math.max(size.x, size.y, size.z)).toBeLessThan(166);
      model.dispose();
    },
  );
  it('occludes the inner screen from the back of an unfolded phone', () => {
    const model = createDuoModel(new THREE.Texture(), new THREE.Texture());
    const hit = new THREE.Raycaster(
      new THREE.Vector3(40, 0, -80),
      new THREE.Vector3(0, 0, 1),
    ).intersectObjects(model.hitObjects, false)[0]!;
    expect(hit.object.userData['display']).toBeUndefined();
    model.dispose();
  });
});
