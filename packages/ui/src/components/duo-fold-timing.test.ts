import { expect, it } from 'vitest';
import { duoFoldAngle } from './duo-fold-timing';

it('uses the requested 4×, 1× and 2× speed segments over two seconds', () => {
  for (const [from, target] of [
    [0, 180],
    [180, 0],
    [110, 0],
  ] as const) {
    const progress = (time: number) => (duoFoldAngle(from, target, time) - from) / (target - from);
    expect(progress(0)).toBeCloseTo(0, 12);
    expect(progress(0.5)).toBeCloseTo(0.5, 12);
    expect(progress(1)).toBeCloseTo(0.625, 12);
    expect(progress(1.5)).toBeCloseTo(0.75, 12);
    expect(progress(1.999)).toBeLessThan(1);
    expect(progress(2)).toBe(1);
    expect(progress(3)).toBe(1);
    for (let step = 1; step <= 20; step++) {
      const delta = progress(step / 10) - progress((step - 1) / 10);
      expect(delta).toBeCloseTo(
        step <= 5 ? 0.1
        : step <= 15 ? 0.025
        : 0.05,
        12,
      );
    }
  }
});

it('starts at the current pose, moves monotonically and settles at the target', () => {
  for (const fps of [30, 60, 120]) {
    let previous = 180;
    for (let frame = 0; frame <= fps * 2; frame++) {
      const angle = duoFoldAngle(180, 0, frame / fps);
      expect(angle).toBeLessThanOrEqual(previous);
      expect(angle).toBeGreaterThanOrEqual(0);
      previous = angle;
    }
    expect(previous).toBe(0);
  }
  const reversedFrom = duoFoldAngle(180, 0, 0.2);
  expect(duoFoldAngle(reversedFrom, 180, 0)).toBeCloseTo(reversedFrom, 12);
  expect(duoFoldAngle(reversedFrom, 180, 2)).toBe(180);
});
