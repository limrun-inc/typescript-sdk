// A 2.5-second fold uses 4× speed for 0.625s, 1× for 1.25s, then 2× for 0.625s.
export function duoFoldAngle(from: number, target: number, seconds: number): number {
  const time = Math.min(2.5, Math.max(0, seconds));
  const progress =
    time <= 0.625 ? time * 0.8
    : time <= 1.875 ? 0.5 + (time - 0.625) * 0.2
    : 0.75 + (time - 1.875) * 0.4;
  return from + (target - from) * progress;
}
