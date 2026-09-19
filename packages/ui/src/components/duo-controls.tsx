import React, { useEffect, useId, useRef, useState } from 'react';
import { HingeSender, type DuoButton } from '../core/duo';

export function useDuoHinge(
  nativeAngle: number,
  send: (angle: number) => Promise<void>,
  failed: (error: string | undefined) => void,
) {
  const [angle, setAngle] = useState(nativeAngle);
  const latest = useRef({ nativeAngle, send, failed });
  latest.current = { nativeAngle, send, failed };
  const pending = useRef<number | undefined>(undefined);
  const interacting = useRef(false);
  const sender = useRef<HingeSender | null>(null);
  useEffect(() => {
    sender.current = new HingeSender(
      async (value) => {
        await latest.current.send(value);
        if (pending.current === value) pending.current = undefined;
      },
      (error) => {
        pending.current = undefined;
        latest.current.failed(String(error));
        setAngle(latest.current.nativeAngle);
      },
    );
    return () => sender.current?.stop();
  }, []);
  useEffect(() => {
    if (!interacting.current && pending.current === undefined) setAngle(nativeAngle);
  }, [nativeAngle]);
  const changeAngle = (value: number) => {
    latest.current.failed(undefined);
    pending.current = value;
    setAngle(value);
    sender.current?.set(value);
  };
  return { angle, changeAngle, interacting };
}

/** Both renderers use the same native fold and rotation controls. */
export function DuoControls({
  angle,
  changeAngle,
  interacting,
  rotate,
  onFold,
  foldTarget,
  onHingeDrag,
  children,
}: {
  angle: number;
  changeAngle: (value: number) => void;
  interacting: React.MutableRefObject<boolean>;
  rotate: () => void;
  onFold?: () => void;
  foldTarget?: number;
  onHingeDrag?: () => void;
  children?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="rc-duo-controls" onPointerDown={(event) => event.stopPropagation()}>
      <div className="rc-duo-hinge">
        <button className="rc-duo-fold" onClick={onFold ?? (() => changeAngle(angle < 90 ? 180 : 0))}>
          {(foldTarget ?? angle) < 90 ? 'Unfold' : 'Fold'}
        </button>
        <label htmlFor={id}>Hinge</label>
        <input
          id={id}
          type="range"
          min={0}
          max={180}
          step={1}
          value={angle}
          onPointerDown={(event) => {
            onHingeDrag?.();
            interacting.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={() => {
            interacting.current = false;
          }}
          onPointerCancel={() => {
            interacting.current = false;
          }}
          onLostPointerCapture={() => {
            interacting.current = false;
          }}
          onChange={(event) => changeAngle(Number(event.target.value))}
        />
        <output>{Math.round(angle)}°</output>
        <button className="rc-duo-rotate" aria-label="Rotate device" title="Rotate device" onClick={rotate}>
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <rect x="7" y="3" width="10" height="18" rx="2" />
            <path d="M3 9a9 9 0 0 1 3-5M3 4v5h5M21 15a9 9 0 0 1-3 5m3 0v-5h-5" />
          </svg>
        </button>
      </div>
      {children && (
        <div className="rc-duo-views" aria-label="Device view">
          {children}
        </div>
      )}
    </div>
  );
}

export function DuoHardwareIcon({ button }: { button: DuoButton }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {button === 'side' ?
        <>
          <rect x="6" y="10" width="12" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </>
      : <>
          <path d="M3 9h4l5-5v16l-5-5H3zM17 12h5" />
          {button === 'volumeUp' && <path d="M19.5 9.5v5" />}
        </>
      }
    </svg>
  );
}
