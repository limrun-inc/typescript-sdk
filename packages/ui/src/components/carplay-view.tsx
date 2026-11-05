import { useEffect, useRef, type RefObject } from 'react';
import type { CarPlayState } from '../core/duo';
import './carplay-view.css';

export function CarPlayView({
  video,
  state,
  viewing,
  pending,
  error,
  setEnabled,
  setViewing,
  touch,
}: {
  video: RefObject<HTMLVideoElement | null>;
  state: CarPlayState | null;
  viewing: boolean;
  pending: boolean;
  error?: string | undefined;
  setEnabled: (enabled: boolean) => void;
  setViewing: (viewing: boolean) => void;
  touch: (action: number, screenId: number, x: number, y: number) => void;
}) {
  const pointer = useRef<number | null>(null);
  const last = useRef({ x: 0, y: 0 });
  const display = state?.display;
  const touchRef = useRef(touch);
  touchRef.current = touch;
  useEffect(() => {
    return () => {
      if (pointer.current !== null && display) {
        touchRef.current(3, display.screenId, last.current.x, last.current.y);
        pointer.current = null;
      }
    };
  }, [viewing, state?.enabled, display?.screenId]);
  const send = (action: number, event: React.PointerEvent<HTMLVideoElement>) => {
    if (!display) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    last.current = {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
    touch(action, display.screenId, last.current.x, last.current.y);
  };
  return (
    <section
      className={`rc-carplay ${viewing ? 'rc-carplay-viewing' : ''}`}
      aria-label="CarPlay"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseMove={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
      onTouchCancel={(event) => event.stopPropagation()}
    >
      <div className="rc-carplay-controls">
        {state?.enabled && (
          <button type="button" onClick={() => setViewing(!viewing)}>
            {viewing ? 'Show phone' : 'Show CarPlay'}
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          aria-pressed={state?.enabled ?? false}
          onClick={() => setEnabled(!state?.enabled)}
        >
          {pending ?
            'Updating CarPlay…'
          : state?.enabled ?
            'Disconnect CarPlay'
          : 'Connect CarPlay'}
        </button>
      </div>
      {error && (
        <div className="rc-carplay-error" role="alert">
          {error}
        </div>
      )}
      <div className="rc-carplay-screen" hidden={!viewing || !state?.enabled}>
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          aria-label="CarPlay display"
          onPointerDown={(event) => {
            if (pointer.current !== null || event.button !== 0) return;
            pointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            send(0, event);
          }}
          onPointerMove={(event) => {
            if (pointer.current === event.pointerId) send(2, event);
          }}
          onPointerUp={(event) => {
            if (pointer.current !== event.pointerId) return;
            send(1, event);
            pointer.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            if (pointer.current !== null && display)
              touch(3, display.screenId, last.current.x, last.current.y);
            pointer.current = null;
          }}
          onPointerCancel={(event) => {
            if (pointer.current === event.pointerId) send(3, event);
            pointer.current = null;
          }}
        />
      </div>
    </section>
  );
}
