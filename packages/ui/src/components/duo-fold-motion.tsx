import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DuoFlatFrame } from './duo-flat-frame';
import { captureDuoFrame, waitForDuoFrame } from './duo-screen-handoff';
import { flatFrameGeometry } from './duo-flat-geometry';
import type { DuoOrientation } from '../core/duo';

type Frame = ReturnType<typeof flatFrameGeometry>;
type Pose = { inner: boolean; frame: Frame };
export type FoldMotion = {
  from: Pose;
  to: Pose;
  before: HTMLCanvasElement;
  after?: HTMLCanvasElement;
  ready: boolean;
};

/** Animate confirmed display changes; resizing, rotation and reduced motion cancel the transition. */
export function useDuoFoldMotion(
  video: React.RefObject<HTMLVideoElement | null>,
  inner: boolean,
  frame: Frame,
  orientation?: DuoOrientation,
  enabled = true,
) {
  const previous = useRef<Pose | undefined>(undefined);
  const previousOrientation = useRef(orientation);
  const current = useRef<Pose>({ inner, frame });
  current.current = { inner, frame };
  const [motion, setMotion] = useState<FoldMotion>();
  const prepared = useRef<FoldMotion | undefined>(undefined);
  const commandTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finish = useCallback(() => {
    clearTimeout(commandTimeout.current);
    prepared.current = undefined;
    setMotion(undefined);
  }, []);
  const prepare = (targetInner: boolean) => {
    if (!enabled || targetInner === inner) {
      finish();
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (prepared.current) return;
    const before = captureDuoFrame(video.current);
    if (!before) return;
    const from = current.current;
    prepared.current = { from, to: from, before, ready: false };
    setMotion(prepared.current);
    commandTimeout.current = setTimeout(finish, 5000);
  };
  useEffect(() => () => clearTimeout(commandTimeout.current), []);
  useLayoutEffect(() => {
    const from = previous.current;
    const to = { inner, frame };
    previous.current = to;
    const rotated = previousOrientation.current !== orientation;
    previousOrientation.current = orientation;
    if (!from) return;
    const resized =
      Math.abs(from.frame.rect.min.x + from.frame.rect.max.x - frame.rect.min.x - frame.rect.max.x) > 0.5 ||
      Math.abs(from.frame.rect.min.y + from.frame.rect.max.y - frame.rect.min.y - frame.rect.max.y) > 0.5;
    if (!enabled || resized || rotated) {
      finish();
      return;
    }
    if (from.inner === inner) {
      // Display metadata can arrive mid-animation; it does not rotate the physical device.
      return;
    }
    setMotion(undefined);
    if (!from.frame.scale || !frame.scale) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const before = prepared.current?.before ?? captureDuoFrame(video.current);
    const origin = prepared.current?.from ?? from;
    clearTimeout(commandTimeout.current);
    prepared.current = undefined;
    if (before) {
      setMotion({ from: origin, to, before, ready: false });
    }
  }, [inner, frame.scale, frame.turns, frame.rect.min.x, frame.rect.min.y, orientation, enabled]);

  useEffect(() => {
    if (!motion || motion.from.inner === inner) return;
    const stop = waitForDuoFrame(video.current, (after) => {
      if (after) setMotion((active) => active && { ...active, to: current.current, after, ready: true });
      else finish();
    });
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduce = () => {
      if (preference?.matches) setMotion(undefined);
    };
    preference?.addEventListener('change', reduce);
    return () => {
      stop();
      preference?.removeEventListener('change', reduce);
    };
  }, [motion?.from, inner]);
  return { motion, finish, prepare };
}

function Still({ pose, image, scale }: { pose: Pose; image?: HTMLCanvasElement; scale: number }) {
  const { bodyWidth, bodyHeight, screenWidth, screenHeight } = pose.frame;
  const width = screenWidth * scale;
  const height = screenHeight * scale;
  return (
    <div className="rc-duo-fold-still" style={{ width: bodyWidth * scale, height: bodyHeight * scale }}>
      <DuoFlatFrame inner={pose.inner} width={bodyWidth} height={bodyHeight} />
      <div
        className="rc-duo-flat-screen"
        style={{
          width,
          height,
          left: ((bodyWidth - screenWidth) * scale) / 2,
          top: ((bodyHeight - screenHeight) * scale) / 2,
          borderRadius:
            pose.inner ? 5.3 * scale : [0.8, 6.6, 6.6, 0.8].map((r) => r * scale + 'px').join(' '),
        }}
      >
        {image && (
          <canvas
            ref={(element) => {
              if (element) {
                element.width = image.width;
                element.height = image.height;
                element.getContext('2d')?.drawImage(image, 0, 0);
              }
            }}
            style={{
              width: pose.inner ? height : width,
              height: pose.inner ? width : height,
              transform: `translate(-50%, -50%) rotate(${pose.inner ? 90 : 0}deg)`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Load the tiny folding renderer only for a confirmed display change. */
export function DuoFoldMotion({ motion, onFinish }: { motion: FoldMotion; onFinish: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rendering, setRendering] = useState(false);
  useEffect(() => {
    setRendering(false);
    if (!motion.ready) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import('./duo-fold-renderer')
      .then(({ renderFold }) => {
        if (cancelled || !canvas.current) return;
        dispose = renderFold(canvas.current, motion, onFinish);
        setRendering(true);
      })
      .catch(() => {
        if (!cancelled) onFinish();
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [motion.ready, motion.from, onFinish]);
  return (
    <>
      {!rendering && (
        <div
          className="rc-duo-fold-hold"
          aria-hidden="true"
          style={{
            width: motion.from.frame.bodyWidth * motion.from.frame.scale,
            height: motion.from.frame.bodyHeight * motion.from.frame.scale,
            transform: `translate(-50%, -50%) rotate(${motion.from.frame.turns * 90}deg)`,
          }}
        >
          <Still pose={motion.from} image={motion.before} scale={motion.from.frame.scale} />
        </div>
      )}
      <canvas
        ref={canvas}
        className="rc-duo-fold-canvas"
        aria-hidden="true"
        style={{ visibility: rendering ? 'visible' : 'hidden' }}
      />
    </>
  );
}
