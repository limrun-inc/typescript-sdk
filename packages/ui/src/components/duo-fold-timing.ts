// A 2-second ease-out keeps the hinge fast at first and slows it smoothly to rest.
export function duoFoldAngle(from: number, target: number, seconds: number): number {
  const progress = Math.min(1, Math.max(0, seconds / 2));
  return target + (from - target) * (1 - progress) ** 3;
}
