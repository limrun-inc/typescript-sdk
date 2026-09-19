// A two-second fold uses 4× speed for 0.5s, 1× for 1s, then 2× for 0.5s.
export function duoFoldAngle(from: number, target: number, seconds: number): number {
  const time = Math.min(2, Math.max(0, seconds));
  const progress =
    time <= 0.5 ? time
    : time <= 1.5 ? 0.5 + (time - 0.5) / 4
    : 0.75 + (time - 1.5) / 2;
  return from + (target - from) * progress;
}
