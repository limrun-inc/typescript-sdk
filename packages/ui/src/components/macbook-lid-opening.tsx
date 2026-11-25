import { useEffect, useRef } from 'react';
import type { LidOpening } from './macbook-lid-renderer';

/**
 * Opens the MacBook's lid in WebGL over the CSS frame, which stays hidden until it finishes. The
 * renderer loads only for an opening. Without WebGL, onFail hands the opening to the CSS frame.
 */
export function MacbookLidOpening({
  opening,
  onFinish,
  onFail,
}: {
  opening: LidOpening;
  onFinish: () => void;
  onFail: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ opening, onFinish, onFail });
  latest.current = { opening, onFinish, onFail };
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import('./macbook-lid-renderer')
      .then(({ renderLidOpening }) => {
        if (cancelled || !canvas.current) return;
        dispose = renderLidOpening(canvas.current, latest.current.opening, () => latest.current.onFinish());
      })
      .catch(() => {
        if (!cancelled) latest.current.onFail();
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  return <canvas ref={canvas} className="rc-macbook-opening" aria-hidden="true" />;
}
