// Stretch the original exponential easing: 3× to 95%, 2× to 99%, then its original tail.
export function duoFoldAngle(from: number, target: number, seconds: number): number {
  const to95 = -Math.log(0.05) / 6;
  const to99 = to95 + Math.log(5) / 9;
  const elapsed = Math.max(0, seconds);
  const remaining =
    elapsed <= to95 ? Math.exp(-6 * elapsed)
    : elapsed <= to99 ? 0.05 * Math.exp(-9 * (elapsed - to95))
    : 0.01 * Math.exp(-18 * (elapsed - to99));
  const angle = target + (from - target) * remaining;
  return Math.abs(angle - target) < 0.001 ? target : angle;
}
