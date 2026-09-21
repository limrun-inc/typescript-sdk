import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { DUO_BUTTONS, DuoButtonSender, flatDisplayTouch, type DuoButton } from '../core/duo';
import type { DuoFrameProps } from './duo-frame';
import { DuoControls, DuoHardwareIcon, useDuoHinge } from './duo-controls';
import { DuoFlatFrame } from './duo-flat-frame';
import { flatFrameGeometry, flatHoverEdge } from './duo-flat-geometry';
import { DuoFoldMotion, useDuoFoldMotion } from './duo-fold-motion';

const DuoFrame = lazy(() => import('./duo-frame'));

type DuoViewProps = DuoFrameProps & { showFrame?: boolean };

/** Native video is the default; only an explicit 3D selection loads the renderer and body asset. */
export default function DuoView(props: DuoViewProps) {
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  return (
    <div className="rc-duo-view">
      {props.showFrame !== false && mode === '3d' ?
        <Suspense fallback={<DuoFlat {...props} />}>
          <DuoFrame {...props} />
        </Suspense>
      : <DuoFlat {...props} />}
      {props.showFrame !== false && (
        <div className="rc-duo-mode" role="group" aria-label="Device rendering">
          <button type="button" aria-pressed={mode === '2d'} onClick={() => setMode('2d')}>
            2D
          </button>
          <button type="button" aria-pressed={mode === '3d'} onClick={() => setMode('3d')}>
            3D
          </button>
        </div>
      )}
    </div>
  );
}

function DuoFlat(props: DuoViewProps) {
  const showFrame = props.showFrame !== false;
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string>();
  const [edge, setEdge] = useState<ReturnType<typeof flatHoverEdge>>();
  const [hovered, setHovered] = useState<DuoButton>();
  const [pressed, setPressed] = useState<DuoButton>();
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
  const inner = display?.id === 'inner';
  const frame = flatFrameGeometry(inner, turns, size.width, size.height);
  const screenWidth = showFrame ? frame.screenWidth : (inner ? display?.height : display?.width) ?? 1;
  const screenHeight = showFrame ? frame.screenHeight : (inner ? display?.width : display?.height) ?? 1;
  const bodyWidth = showFrame ? frame.bodyWidth : screenWidth;
  const bodyHeight = showFrame ? frame.bodyHeight : screenHeight;
  const scale =
    showFrame ?
      frame.scale
    : Math.max(
        0,
        Math.min(
          size.width / (frame.turns % 2 ? bodyHeight : bodyWidth),
          size.height / (frame.turns % 2 ? bodyWidth : bodyHeight),
        ),
      );
  const width = screenWidth * scale;
  const height = screenHeight * scale;

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

  const {
    motion,
    finish: finishMotion,
    prepare,
  } = useDuoFoldMotion(video, inner, frame, props.state.orientation, showFrame);
  const { angle, changeAngle, interacting } = useDuoHinge(
    props.state.angleDegrees,
    async (value) => {
      prepare(value >= 90);
      try {
        await props.setAngle(value);
      } catch (reason) {
        finishMotion();
        throw reason;
      }
    },
    setError,
  );

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
      setPressed(undefined);
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

  const releaseButton = () => {
    hardware.current?.release();
    setPressed(undefined);
  };
  const buttonEvents = (button: DuoButton): React.ButtonHTMLAttributes<HTMLButtonElement> => ({
    onPointerDown: (event) => {
      if (motion || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      hardware.current?.press(button);
      setPressed(button);
    },
    onPointerUp: releaseButton,
    onPointerCancel: releaseButton,
    onLostPointerCapture: releaseButton,
    onBlur: releaseButton,
    onPointerEnter: () => setHovered(button),
    onPointerLeave: () => setHovered(undefined),
    onFocus: () => setEdge(frame.guides.find((g) => g.button === button)?.edge),
    onKeyDown: (event) => {
      if (motion) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) {
          hardware.current?.press(button);
          setPressed(button);
        }
      }
    },
    onKeyUp: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        releaseButton();
      }
    },
  });
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return flatDisplayTouch(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
      turns,
    );
  };
  return (
    <div className={showFrame ? 'rc-duo' : 'rc-duo rc-duo-frameless'}>
      <div
        ref={stage}
        className="rc-duo-flat-stage"
        data-folding={!!motion}
        aria-busy={!!motion}
        onPointerMove={(event) => {
          if (!showFrame) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setEdge(flatHoverEdge(event.clientX - rect.left, event.clientY - rect.top, frame.rect));
        }}
        onPointerLeave={() => {
          setEdge(undefined);
          setHovered(undefined);
        }}
      >
        <div
          className="rc-duo-flat-device"
          data-display={inner ? 'inner' : 'outer'}
          style={{
            width: bodyWidth * scale,
            height: bodyHeight * scale,
            transform: 'translate(-50%, -50%) rotate(' + frame.turns * 90 + 'deg)',
          }}
        >
          {showFrame && <DuoFlatFrame inner={inner} width={bodyWidth} height={bodyHeight} />}
          <div
            className="rc-duo-flat-screen"
            role="application"
            aria-label="iPhone Duo 2D simulator"
            tabIndex={0}
            style={{
              width,
              height,
              left: ((bodyWidth - screenWidth) / 2) * scale,
              top: ((bodyHeight - screenHeight) / 2) * scale,
              borderRadius:
                !showFrame ? 0
                : inner ? 5.3 * scale
                : [0.8, 6.6, 6.6, 0.8].map((r) => r * scale + 'px').join(' '),
            }}
            onKeyDown={motion ? undefined : props.onKeyDown}
            onKeyUp={props.onKeyUp}
            onPointerDown={(event) => {
              if (motion || held.current || event.button !== 0 || !display) return;
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
                width: inner ? height : width,
                height: inner ? width : height,
                transform: 'translate(-50%, -50%) rotate(' + (inner ? 90 : 0) + 'deg)',
              }}
            />
          </div>
          {showFrame &&
            frame.buttons.map((b) => (
              <button
                key={b.button}
                type="button"
                className="rc-duo-physical"
                data-duo-button={b.button}
                data-edge={b.edge}
                data-highlighted={hovered === b.button}
                data-pressed={pressed === b.button}
                aria-label={DUO_BUTTONS[b.button] + ' physical button'}
                title={DUO_BUTTONS[b.button]}
                style={{
                  left: b.x * scale,
                  top: b.y * scale,
                  width: b.edge === 'top' ? Math.max(28, b.width * scale) : 28,
                  height: b.edge === 'top' ? 28 : Math.max(28, b.height * scale),
                }}
                {...buttonEvents(b.button)}
              >
                <span
                  style={{ width: Math.max(2, b.width * scale), height: Math.max(2, b.height * scale) }}
                />
              </button>
            ))}
        </div>
        {showFrame &&
          frame.guides.map((g) => (
            <button
              key={g.button}
              type="button"
              className="rc-duo-hardware"
              data-duo-button={g.button}
              data-visible={edge === g.edge}
              data-pressed={pressed === g.button}
              aria-label={DUO_BUTTONS[g.button]}
              title={DUO_BUTTONS[g.button]}
              style={
                {
                  left: g.targetX,
                  top: g.targetY,
                  '--duo-hardware-icon-size': `${frame.iconSize}px`,
                  '--duo-hardware-icon-x': `${g.x - g.targetX}px`,
                  '--duo-hardware-icon-y': `${g.y - g.targetY}px`,
                } as React.CSSProperties
              }
              {...buttonEvents(g.button)}
            >
              <DuoHardwareIcon button={g.button} />
            </button>
          ))}
        {motion && <DuoFoldMotion motion={motion} onFinish={finishMotion} />}
      </div>
      {showFrame && (
        <DuoControls
          angle={angle}
          changeAngle={changeAngle}
          interacting={interacting}
          rotate={() => {
            void props
              .setOrientation(props.state.orientation === 'portrait' ? 'landscape-left' : 'portrait')
              .catch((e) => setError(String(e)));
          }}
        >
          <span className="rc-duo-view-label">Front view</span>
        </DuoControls>
      )}
      {error && (
        <div role="alert" className="rc-duo-error">
          {error}
        </div>
      )}
    </div>
  );
}
