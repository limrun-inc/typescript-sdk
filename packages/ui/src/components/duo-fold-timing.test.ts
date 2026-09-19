import { expect, it } from 'vitest';
import { duoFoldAngle } from './duo-fold-timing';

it('takes three times as long to reach 95%, then twice as long to reach 99%', () => {
  const original95 = -Math.log(0.05) / 18;
  const original99 = -Math.log(0.01) / 18;
  const at95 = original95 * 3;
  const at99 = at95 + (original99 - original95) * 2;
  for (const [from, target] of [
    [0, 180],
    [180, 0],
    [110, 0],
  ] as const) {
    const progress = (time: number) => (duoFoldAngle(from, target, time) - from) / (target - from);
    expect(progress(at95)).toBeCloseTo(0.95, 12);
    expect(progress(at99)).toBeCloseTo(0.99, 12);
    expect(progress(at99 + Math.log(10) / 18)).toBeCloseTo(0.999, 12);
  }
});

it('starts at the current pose, moves monotonically and settles at the target', () => {
  for (const fps of [30, 60, 120]) {
    let previous = 180;
    for (let frame = 0; frame <= fps * 1.2; frame++) {
      const angle = duoFoldAngle(180, 0, frame / fps);
      expect(angle).toBeLessThanOrEqual(previous);
      expect(angle).toBeGreaterThanOrEqual(0);
      previous = angle;
    }
    expect(previous).toBe(0);
  }
  const reversedFrom = duoFoldAngle(180, 0, 0.2);
  expect(duoFoldAngle(reversedFrom, 180, 0)).toBeCloseTo(reversedFrom, 12);
  expect(duoFoldAngle(reversedFrom, 180, 1.2)).toBe(180);
});
