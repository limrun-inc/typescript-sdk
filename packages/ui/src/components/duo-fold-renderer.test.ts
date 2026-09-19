import { expect, it } from 'vitest';
import { foldMeshes, foldPose } from './duo-fold-renderer';
it('keeps the folding model under 2000 triangles and uses bounded screen UVs', () => {
  const meshes = foldMeshes();
  expect(meshes.reduce((n, m) => n + m.vertices.length / 24, 0)).toBeLessThan(2000);
  expect(meshes).toHaveLength(15);
  for (const mesh of meshes) {
    expect([...mesh.vertices].every(Number.isFinite)).toBe(true);
    if (mesh.kind === 'inner' || mesh.kind === 'outer')
      for (let i = 0; i < mesh.vertices.length; i += 8) {
        expect(mesh.vertices[i + 6]).toBeGreaterThanOrEqual(0);
        expect(mesh.vertices[i + 6]).toBeLessThanOrEqual(1);
        expect(mesh.vertices[i + 7]).toBeGreaterThanOrEqual(0);
        expect(mesh.vertices[i + 7]).toBeLessThanOrEqual(1);
      }
  }
});
it('keeps the hinge attached, closes fully and settles both leaves flat', () => {
  expect(foldPose(0)).toEqual({ left: Math.PI, right: 0, shift: -41.15 });
  expect(foldPose(1)).toEqual({ left: 0, right: 0, shift: 0 });
  expect(foldPose(0.48).left).toBeGreaterThan(0);
  expect(foldPose(0.48).right).toBeLessThan(0);
  let previous = Math.PI;
  for (let i = 0; i <= 100; i++) {
    const pose = foldPose(i / 100);
    expect(pose.left).toBeLessThanOrEqual(previous);
    previous = pose.left;
  }
});
