import { useEffect, useRef, useState } from 'react';
import { useDuoHinge } from './duo-controls';
import { duoFoldAngle } from './duo-fold-timing';

type Fold = { from: number; target: number; startedAt: number };

/** Drive button folds through the slider's native angle queue. */
export function useDuoButtonHinge(
  nativeAngle: number,
  send: (angle: number) => Promise<void>,
  failed: (error: string | undefined) => void,
) {
  const motion = useRef<Fold | undefined>(undefined);
  const request = useRef(0);
  const [target, setTarget] = useState<number>();
  const hinge = useDuoHinge(nativeAngle, send, (reason) => {
    if (reason !== undefined) cancelFold();
    failed(reason);
  });
  const latest = useRef(hinge);
  latest.current = hinge;
  const cancelFold = () => {
    if (!motion.current) return;
    cancelAnimationFrame(request.current);
    motion.current = undefined;
    hinge.interacting.current = false;
    setTarget(undefined);
  };
  const fold = () => {
    const now = performance.now();
    const previous = motion.current;
    const from =
      previous ?
        duoFoldAngle(previous.from, previous.target, (now - previous.startedAt) / 1000)
      : hinge.angle;
    const to = (previous?.target ?? hinge.angle) < 90 ? 180 : 0;
    cancelFold();
    const next = { from, target: to, startedAt: now };
    motion.current = next;
    hinge.interacting.current = true;
    setTarget(to);
    let lastSent = -Infinity;
    const tick = (time: number) => {
      if (motion.current !== next) return;
      const angle = duoFoldAngle(from, to, (time - now) / 1000);
      // Native HID updates are bounded; the 3D pose uses the same clock at display refresh rate.
      if (time - lastSent >= 1000 / 30 || angle === to) {
        lastSent = time;
        latest.current.changeAngle(angle);
      }
      if (angle === to) cancelFold();
      else request.current = requestAnimationFrame(tick);
    };
    request.current = requestAnimationFrame(tick);
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(request.current);
      motion.current = undefined;
      latest.current.interacting.current = false;
    },
    [],
  );
  return {
    ...hinge,
    motion,
    target,
    fold,
    cancelFold,
    changeAngle: (value: number) => {
      cancelFold();
      hinge.changeAngle(value);
    },
  };
}
