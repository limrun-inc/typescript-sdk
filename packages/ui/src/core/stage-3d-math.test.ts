import { describe, expect, it } from 'vitest';
import { facing, projectPoint, rotationBasis, unprojectPoint } from './stage-3d-math';

const PERSPECTIVE = 1200;

describe('stage-3d-math', () => {
  it('is the identity when the stage is flat', () => {
    const projected = projectPoint(0, 0, PERSPECTIVE, 123.4, -56.7);
    expect(projected).not.toBeNull();
    expect(projected!.x).toBeCloseTo(123.4, 6);
    expect(projected!.y).toBeCloseTo(-56.7, 6);

    const unprojected = unprojectPoint(0, 0, PERSPECTIVE, 123.4, -56.7);
    expect(unprojected).not.toBeNull();
    expect(unprojected!.x).toBeCloseTo(123.4, 6);
    expect(unprojected!.y).toBeCloseTo(-56.7, 6);
  });

  it('round-trips project → unproject across the interaction range', () => {
    const angles = [-45, -20, -8, -1, 0, 3, 12, 30, 60];
    const points = [
      { u: 0, v: 0 },
      { u: 180, v: 390 },
      { u: -180, v: -390 },
      { u: 175.25, v: -12.5 },
      { u: -30, v: 400 },
    ];
    for (const rx of angles) {
      for (const ry of angles) {
        for (const { u, v } of points) {
          const screen = projectPoint(rx, ry, PERSPECTIVE, u, v);
          expect(screen).not.toBeNull();
          const local = unprojectPoint(rx, ry, PERSPECTIVE, screen!.x, screen!.y);
          expect(local).not.toBeNull();
          expect(local!.x).toBeCloseTo(u, 4);
          expect(local!.y).toBeCloseTo(v, 4);
        }
      }
    }
  });

  it('moves the right edge away from the viewer for positive rotateY', () => {
    // "Turn to face the cursor": cursor on the right → positive rotateY →
    // the right edge (u > 0) recedes, so its projection shrinks toward the
    // center rather than growing.
    const projected = projectPoint(0, 20, PERSPECTIVE, 200, 0);
    expect(projected).not.toBeNull();
    expect(projected!.x).toBeLessThan(200);
  });

  it('reports facing correctly', () => {
    expect(facing(0, 0)).toBeCloseTo(1, 6);
    expect(facing(0, 90)).toBeCloseTo(0, 6);
    expect(facing(0, 180)).toBeCloseTo(-1, 6);
    expect(facing(45, 45)).toBeGreaterThan(0);
  });

  it('rejects unprojection when looking at the back of the device', () => {
    // At 180° the ray through the origin still intersects the plane, but any
    // other screen point maps behind the eye or via a negative ray parameter.
    expect(unprojectPoint(0, 170, PERSPECTIVE, 50, 10)).toBeNull();
  });

  it('keeps the rotation basis orthonormal', () => {
    const { xAxis, yAxis, normal } = rotationBasis(33, -58);
    const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
      a.x * b.x + a.y * b.y + a.z * b.z;
    expect(dot(xAxis, yAxis)).toBeCloseTo(0, 9);
    expect(dot(xAxis, normal)).toBeCloseTo(0, 9);
    expect(dot(yAxis, normal)).toBeCloseTo(0, 9);
    expect(dot(xAxis, xAxis)).toBeCloseTo(1, 9);
    expect(dot(yAxis, yAxis)).toBeCloseTo(1, 9);
    expect(dot(normal, normal)).toBeCloseTo(1, 9);
  });
});
