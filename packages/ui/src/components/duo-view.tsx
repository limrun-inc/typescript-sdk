import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { DUO_BUTTONS, DuoButtonSender, flatDisplayTouch, type DuoButton } from '../core/duo';
import type { DuoFrameProps } from './duo-frame';

const DuoFrame = lazy(() => import('./duo-frame'));

/** Native video is the default; only an explicit 3D selection loads the renderer and body asset. */
export default function DuoView(props: DuoFrameProps) {
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  return (
    <div className="rc-duo-view">
      {mode === '3d' ?
        <Suspense fallback={<DuoFlat {...props} />}>
          <DuoFrame {...props} />
        </Suspense>
      : <DuoFlat {...props} />}
      <div className="rc-duo-mode" role="group" aria-label="Device rendering">
        <button type="button" aria-pressed={mode === '2d'} onClick={() => setMode('2d')}>
          2D
        </button>
        <button type="button" aria-pressed={mode === '3d'} onClick={() => setMode('3d')}>
          3D
        </button>
      </div>
    </div>
  );
}

function DuoFlat(props: DuoFrameProps) {
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const held = useRef<{ pointer: number; screenId: number; x: number; y: number } | undefined>(undefined);
  const hardware = useRef<DuoButtonSender | null>(null);
  const display = props.state.displays.find(
    (d) => d.id === (props.state.angleDegrees < 90 ? 'outer' : 'inner'),
  );
  const source = display?.id === 'inner' ? props.inner : props.outer;
  const turns =
    display?.orientation === 2 ? 2
    : display?.orientation === 3 ? 1
    : display?.orientation === 4 ? 3
    : 0;
  const nativeWidth = display?.width ?? 1398;
  const nativeHeight = display?.height ?? 2034;
  const ratio = turns % 2 ? nativeHeight / nativeWidth : nativeWidth / nativeHeight;
  const width = Math.max(0, Math.min(size.width - 64, (size.height - 64) * ratio));
  const height = width / ratio;

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const target = video.current;
    if (!target || !source) return;
    const sync = () => {
      if (target.srcObject !== source.srcObject) target.srcObject = source.srcObject;
      void target.play().catch(() => undefined);
      props.outer?.pause();
      props.inner?.pause();
    };
    sync();
    source.addEventListener('loadedmetadata', sync);
    return () => {
      source.removeEventListener('loadedmetadata', sync);
      target.pause();
      target.srcObject = null;
      for (const original of [props.outer, props.inner]) void original?.play().catch(() => undefined);
    };
  }, [source, props.outer, props.inner]);

  const releaseTouch = () => {
    if (!held.current) return;
    const { screenId, x, y } = held.current;
    latest.current.touch(1, screenId, x, y);
    held.current = undefined;
  };
  useEffect(() => {
    hardware.current = new DuoButtonSender(
      (button, down) => latest.current.button(button, down),
      (e) => setError(String(e)),
    );
    const release = () => {
      releaseTouch();
      hardware.current?.release();
    };
    window.addEventListener('blur', release);
    return () => {
      release();
      window.removeEventListener('blur', release);
    };
  }, []);
  useEffect(() => {
    releaseTouch();
  }, [display?.screenId, turns]);

  const control = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return flatDisplayTouch(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
      turns,
    );
  };
  return (
    <div className="rc-duo">
      <div ref={stage} className="rc-duo-flat-stage">
        <div className="rc-duo-flat-device" style={{ width: width + 16, height: height + 16 }}>
          <div
            className="rc-duo-flat-screen"
            role="application"
            aria-label="iPhone Duo 2D simulator"
            tabIndex={0}
            style={{ width, height }}
            onKeyDown={props.onKeyDown}
            onKeyUp={props.onKeyUp}
            onPointerDown={(event) => {
              if (held.current || event.button !== 0 || !display) return;
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              const p = point(event);
              held.current = { pointer: event.pointerId, screenId: display.screenId, ...p };
              props.touch(0, display.screenId, p.x, p.y);
            }}
            onPointerMove={(event) => {
              if (held.current?.pointer !== event.pointerId) return;
              const p = point(event);
              Object.assign(held.current, p);
              props.touch(2, held.current.screenId, p.x, p.y);
            }}
            onPointerUp={(event) => {
              if (held.current?.pointer === event.pointerId) releaseTouch();
            }}
            onPointerCancel={releaseTouch}
            onLostPointerCapture={releaseTouch}
          >
            <video
              ref={video}
              autoPlay
              muted
              playsInline
              style={{
                width: turns % 2 ? height : width,
                height: turns % 2 ? width : height,
                transform: `translate(-50%, -50%) rotate(${turns * 90}deg)`,
              }}
            />
          </div>
        </div>
      </div>
      <div className="rc-duo-controls rc-duo-flat-controls">
        <button
          disabled={busy}
          onClick={() => void control(() => props.setAngle(props.state.angleDegrees < 90 ? 180 : 0))}
        >
          {props.state.angleDegrees < 90 ? 'Unfold' : 'Fold'}
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void control(() =>
              props.setOrientation(props.state.orientation === 'portrait' ? 'landscape-left' : 'portrait'),
            )
          }
        >
          Rotate device
        </button>
        {(Object.keys(DUO_BUTTONS) as DuoButton[]).map((button) => (
          <button
            key={button}
            type="button"
            aria-label={DUO_BUTTONS[button]}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              hardware.current?.press(button);
            }}
            onPointerUp={() => hardware.current?.release()}
            onPointerCancel={() => hardware.current?.release()}
            onLostPointerCapture={() => hardware.current?.release()}
            onBlur={() => hardware.current?.release()}
            onKeyDown={(event) => {
              if (['Enter', ' '].includes(event.key)) {
                event.preventDefault();
                if (!event.repeat) hardware.current?.press(button);
              }
            }}
            onKeyUp={(event) => {
              if (['Enter', ' '].includes(event.key)) {
                event.preventDefault();
                hardware.current?.release();
              }
            }}
          >
            {button === 'side' ?
              'Sleep/Wake'
            : button === 'volumeUp' ?
              'Volume +'
            : 'Volume −'}
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="rc-duo-error">
          {error}
        </div>
      )}
    </div>
  );
}
