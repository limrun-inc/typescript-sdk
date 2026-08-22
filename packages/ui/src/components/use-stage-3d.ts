import { useEffect, useMemo, useRef, useState } from 'react';
import { facing, unprojectPoint } from '../core/stage-3d-math';

// Perspective distance used for the stage transform. Also used by the
// inverse projection, so keep the CSS and the math in sync through this
// constant.
const PERSPECTIVE_PX = 1200;
// Maximum cursor-follow tilt. Deliberately subtle.
const MAX_TILT_DEG = 6;
// Degrees of rotation per pixel of pointer travel while grabbing.
const GRAB_SENSITIVITY = 0.35;
// Critically damped spring used to settle back toward the resting pose.
const SPRING_STIFFNESS = 170;
const SPRING_DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS);
// Exponential decay rate of a flick's angular velocity (1/s).
const SPIN_FRICTION = 2.2;
// Below this speed (deg/s) a spin hands off to the settle spring.
const SPIN_END_SPEED = 100;
// Release speed (deg/s) required for a flick to keep spinning.
const FLICK_MIN_SPEED = 260;
const FLICK_MAX_SPEED = 2200;
// The X axis never tumbles: clamp while grabbing.
const MAX_ROT_X_DEG = 65;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type ElementRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type StageMetrics = {
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

type GrabState = {
  // Touch identifier, or -1 for the mouse pointer.
  pointerId: number;
  lastX: number;
  lastY: number;
  lastT: number;
};

export type Stage3D = {
  // Resolved activation: the prop is on and the user does not prefer
  // reduced motion. Drives the `rc-3d` class.
  active: boolean;
  stageRef: React.RefObject<HTMLDivElement | null>;
  glareRef: React.RefObject<HTMLDivElement | null>;
  backRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Feed every container pointer event through here before the normal
   * touch-injection path. Returns true when the event was consumed by the
   * 3D stage (a grab/rotation gesture) and must not reach the device.
   */
  handleInteraction: (event: React.MouseEvent | React.TouchEvent) => boolean;
  /**
   * Map a client-space point to the position it occupies on the
   * untransformed device surface. Identity when the stage is flat or 3D is
   * inactive, so it is always safe to apply.
   */
  unprojectClient: (clientX: number, clientY: number) => { x: number; y: number };
  /**
   * Layout-space (untransformed) client rect of the video element. Returns
   * null when 3D is inactive so callers can fall back to
   * getBoundingClientRect, which is only correct without a 3D transform.
   */
  getVideoLayoutRect: () => DOMRect | null;
  /**
   * Precision modes (Alt-pinch, inspect overlay) flatten the device and
   * suspend tilt/grab so on-screen indicators drawn outside the stage line
   * up exactly with the video.
   */
  setFlattened: (flattened: boolean) => void;
};

export const useStage3D = ({
  enabled,
  containerRef,
  videoRef,
  frameRef,
  showFrame,
}: {
  enabled: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  frameRef: React.RefObject<HTMLImageElement | null>;
  showFrame: boolean;
}): Stage3D => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const glareRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLDivElement | null>(null);

  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const active = enabled && !reducedMotion;
  const activeRef = useRef(active);
  activeRef.current = active;
  const showFrameRef = useRef(showFrame);
  showFrameRef.current = showFrame;

  // All animation state lives in refs: the loop writes styles directly and
  // never re-renders React.
  const rotRef = useRef({ x: 0, y: 0 });
  const velRef = useRef({ x: 0, y: 0 });
  const tiltTargetRef = useRef({ x: 0, y: 0 });
  const modeRef = useRef<'rest' | 'settle' | 'grab' | 'spin'>('rest');
  const grabRef = useRef<GrabState | null>(null);
  const flattenedRef = useRef(false);
  const rafRef = useRef<number | undefined>(undefined);
  const lastTickRef = useRef(0);

  // The ref objects themselves are stable (they come from useRef in the
  // component), so the memoized callbacks below can close over them safely.
  const api = useMemo<Omit<Stage3D, 'active'>>(() => {
    const getStageMetrics = (): StageMetrics | null => {
      const container = containerRef.current;
      const stage = stageRef.current;
      if (!container || !stage) return null;
      // The container never carries a transform, so its bounding rect is
      // layout-accurate; offsets locate the stage inside it independently of
      // the stage's own (3D-transformed) bounding rect. The transform origin
      // is the stage center, which the transform leaves fixed.
      const containerRect = container.getBoundingClientRect();
      const left = containerRect.left + container.clientLeft + stage.offsetLeft;
      const top = containerRect.top + container.clientTop + stage.offsetTop;
      const width = stage.offsetWidth;
      const height = stage.offsetHeight;
      return { left, top, width, height, centerX: left + width / 2, centerY: top + height / 2 };
    };

    // Layout-space rect of an element that is a positioned/in-flow child of
    // the stage, expressed in client coordinates as if no transform applied.
    const getChildLayoutRect = (element: HTMLElement, centeredByTranslate: boolean): ElementRect | null => {
      const metrics = getStageMetrics();
      if (!metrics) return null;
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      let left = metrics.left + element.offsetLeft;
      let top = metrics.top + element.offsetTop;
      if (centeredByTranslate) {
        // .rc-video (framed) positions itself at 50%/50% with a
        // translate(-50%, -50%) that offsetLeft/offsetTop don't include.
        left -= width / 2;
        top -= height / 2;
      }
      return { left, top, right: left + width, bottom: top + height, width, height };
    };

    const getVideoRect = (): ElementRect | null => {
      const video = videoRef.current;
      if (!video) return null;
      return getChildLayoutRect(video, showFrameRef.current);
    };

    const getFrameRect = (): ElementRect | null => {
      const frame = frameRef.current;
      if (!showFrameRef.current || !frame) return null;
      return getChildLayoutRect(frame, false);
    };

    const getDeviceRect = (): ElementRect | null => getFrameRect() ?? getVideoRect();

    const isIdle = () => {
      const rot = rotRef.current;
      const vel = velRef.current;
      return (
        Math.abs(rot.x) < 0.01 && Math.abs(rot.y) < 0.01 && Math.abs(vel.x) < 0.05 && Math.abs(vel.y) < 0.05
      );
    };

    // Normalize an angle to (-180, 180] for glare intensity math.
    const normalizeAngle = (deg: number) => {
      const wrapped = ((deg % 360) + 540) % 360;
      return wrapped - 180;
    };

    const syncOverlayGeometry = (overlay: HTMLElement, rect: ElementRect, metrics: StageMetrics) => {
      const left = `${rect.left - metrics.left}px`;
      const top = `${rect.top - metrics.top}px`;
      const width = `${rect.width}px`;
      const height = `${rect.height}px`;
      if (overlay.style.left !== left) overlay.style.left = left;
      if (overlay.style.top !== top) overlay.style.top = top;
      if (overlay.style.width !== width) overlay.style.width = width;
      if (overlay.style.height !== height) overlay.style.height = height;
      const radius = `${Math.min(rect.width, rect.height) * 0.16}px`;
      if (overlay.style.borderRadius !== radius) overlay.style.borderRadius = radius;
    };

    const render = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const { x, y } = rotRef.current;
      const flat = Math.abs(x) < 0.01 && Math.abs(y) < 0.01;
      stage.style.transform =
        flat ? '' : `perspective(${PERSPECTIVE_PX}px) rotateX(${x}deg) rotateY(${y}deg)`;

      const metrics = getStageMetrics();
      const deviceRect = metrics ? getDeviceRect() : null;

      const glare = glareRef.current;
      if (glare) {
        if (flat || !deviceRect || !metrics) {
          glare.style.opacity = '0';
        } else {
          syncOverlayGeometry(glare, deviceRect, metrics);
          const yn = normalizeAngle(y);
          // A fixed light up and to the left of the viewer: the highlight
          // sweeps across the glass opposite to the rotation.
          const gx = clamp(50 - yn * 1.6, -60, 160);
          const gy = clamp(50 + x * 1.6, -60, 160);
          const intensity = clamp((Math.abs(x) + Math.abs(yn)) / 24, 0, 1) * 0.22;
          glare.style.opacity = '1';
          glare.style.background = `radial-gradient(circle at ${gx}% ${gy}%, rgba(255,255,255,${intensity.toFixed(
            3,
          )}), rgba(255,255,255,0) 62%)`;
        }
      }

      const back = backRef.current;
      if (back && deviceRect && metrics) {
        syncOverlayGeometry(back, deviceRect, metrics);
      }
    };

    const tick = (now: number) => {
      rafRef.current = undefined;
      const dt = clamp((now - lastTickRef.current) / 1000, 0.001, 0.04);
      lastTickRef.current = now;

      const rot = rotRef.current;
      const vel = velRef.current;
      let keepRunning = true;

      if (modeRef.current === 'grab') {
        // Rotation is driven directly by the pointer handlers; the loop only
        // paints. Bleed sampled velocity slowly so a held-still release
        // doesn't inherit an old flick.
        const decay = Math.exp(-6 * dt);
        vel.x *= decay;
        vel.y *= decay;
      } else if (modeRef.current === 'spin') {
        const decay = Math.exp(-SPIN_FRICTION * dt);
        vel.x *= decay;
        vel.y *= decay;
        rot.x += vel.x * dt;
        rot.y += vel.y * dt;
        // Keep the spin from tumbling end-over-end.
        rot.x += (0 - rot.x) * Math.min(1, 2.5 * dt);
        if (Math.hypot(vel.x, vel.y) < SPIN_END_SPEED) {
          modeRef.current = 'settle';
        }
      } else {
        // Settle: critically damped spring toward the resting pose — the
        // cursor tilt target plus the nearest full Y turn, so a spun device
        // always comes back around to face the viewer.
        const flatten = flattenedRef.current;
        const baseY = Math.round(rot.y / 360) * 360;
        const targetX = flatten ? 0 : tiltTargetRef.current.x;
        const targetY = baseY + (flatten ? 0 : tiltTargetRef.current.y);
        vel.x += (SPRING_STIFFNESS * (targetX - rot.x) - SPRING_DAMPING * vel.x) * dt;
        vel.y += (SPRING_STIFFNESS * (targetY - rot.y) - SPRING_DAMPING * vel.y) * dt;
        rot.x += vel.x * dt;
        rot.y += vel.y * dt;
        if (
          Math.abs(targetX - rot.x) < 0.02 &&
          Math.abs(targetY - rot.y) < 0.02 &&
          Math.abs(vel.x) < 0.05 &&
          Math.abs(vel.y) < 0.05
        ) {
          rot.x = targetX;
          // Land exactly on the target, modulo full turns.
          rot.y = targetY - baseY;
          vel.x = 0;
          vel.y = 0;
          modeRef.current = 'rest';
          keepRunning = false;
        }
      }

      render();
      if (keepRunning) {
        rafRef.current = window.requestAnimationFrame(tick);
      }
    };

    const ensureLoop = () => {
      if (rafRef.current !== undefined) return;
      lastTickRef.current = performance.now();
      rafRef.current = window.requestAnimationFrame(tick);
    };

    const unprojectClient = (clientX: number, clientY: number) => {
      if (!activeRef.current) return { x: clientX, y: clientY };
      const rot = rotRef.current;
      if (Math.abs(rot.x) < 0.01 && Math.abs(rot.y) < 0.01) return { x: clientX, y: clientY };
      const metrics = getStageMetrics();
      if (!metrics) return { x: clientX, y: clientY };
      const local = unprojectPoint(
        rot.x,
        rot.y,
        PERSPECTIVE_PX,
        clientX - metrics.centerX,
        clientY - metrics.centerY,
      );
      if (!local) return { x: clientX, y: clientY };
      return { x: metrics.centerX + local.x, y: metrics.centerY + local.y };
    };

    const updateTiltTarget = (clientX: number, clientY: number) => {
      if (flattenedRef.current) return;
      // Let a flick play out instead of fighting the cursor.
      if (modeRef.current === 'spin' || modeRef.current === 'grab') return;
      const metrics = getStageMetrics();
      if (!metrics) return;
      const deviceRect = getDeviceRect();
      // Normalize by the device size (not the container, which can be much
      // wider): one device-width from center reaches the full tilt.
      const halfX = deviceRect ? Math.max(deviceRect.width, 1) : metrics.width / 2;
      const halfY = deviceRect ? Math.max(deviceRect.height, 1) : metrics.height / 2;
      const nx = clamp((clientX - metrics.centerX) / halfX, -1, 1);
      const ny = clamp((clientY - metrics.centerY) / halfY, -1, 1);
      // Turn to face the cursor: cursor right → positive rotateY (right edge
      // recedes), cursor below → negative rotateX (bottom edge recedes).
      tiltTargetRef.current = { x: -ny * MAX_TILT_DEG, y: nx * MAX_TILT_DEG };
      if (modeRef.current === 'rest') modeRef.current = 'settle';
      ensureLoop();
    };

    const clearTiltTarget = () => {
      tiltTargetRef.current = { x: 0, y: 0 };
      if (modeRef.current === 'rest' && isIdle()) return;
      if (modeRef.current === 'rest') modeRef.current = 'settle';
      ensureLoop();
    };

    const beginGrab = (clientX: number, clientY: number, pointerId: number) => {
      grabRef.current = { pointerId, lastX: clientX, lastY: clientY, lastT: performance.now() };
      modeRef.current = 'grab';
      ensureLoop();
    };

    // Decide whether a press should grab the device instead of touching the
    // screen. Grabbing happens:
    //   - anywhere, to catch a device that is spinning or facing away;
    //   - outside the device entirely (empty container space);
    //   - on the frame's corner bezels — the areas beyond the screen on both
    //     axes. Bezel bands directly above/below/left/right of the screen
    //     keep their existing behavior (edge-clamped touches power gestures
    //     like the home-indicator swipe from below the screen).
    const tryBeginGrab = (clientX: number, clientY: number, pointerId: number): boolean => {
      if (flattenedRef.current) return false;
      if (modeRef.current === 'spin') {
        beginGrab(clientX, clientY, pointerId);
        return true;
      }
      const rot = rotRef.current;
      if (facing(rot.x, rot.y) < 0.2) {
        beginGrab(clientX, clientY, pointerId);
        return true;
      }
      const point = unprojectClient(clientX, clientY);
      const deviceRect = getDeviceRect();
      if (!deviceRect) return false;
      const insideDevice =
        point.x >= deviceRect.left &&
        point.x <= deviceRect.right &&
        point.y >= deviceRect.top &&
        point.y <= deviceRect.bottom;
      if (!insideDevice) {
        beginGrab(clientX, clientY, pointerId);
        return true;
      }
      // Corner bezels only exist when the frame is shown.
      if (!getFrameRect()) return false;
      const videoRect = getVideoRect();
      if (!videoRect) return false;
      const beyondX = point.x < videoRect.left || point.x > videoRect.right;
      const beyondY = point.y < videoRect.top || point.y > videoRect.bottom;
      if (beyondX && beyondY) {
        beginGrab(clientX, clientY, pointerId);
        return true;
      }
      return false;
    };

    const moveGrab = (clientX: number, clientY: number) => {
      const grab = grabRef.current;
      if (!grab) return;
      const now = performance.now();
      const dt = Math.max((now - grab.lastT) / 1000, 1e-3);
      const dx = clientX - grab.lastX;
      const dy = clientY - grab.lastY;
      const rot = rotRef.current;
      rot.y += dx * GRAB_SENSITIVITY;
      rot.x = clamp(rot.x - dy * GRAB_SENSITIVITY, -MAX_ROT_X_DEG, MAX_ROT_X_DEG);
      const vel = velRef.current;
      vel.y = clamp(0.5 * vel.y + 0.5 * ((dx * GRAB_SENSITIVITY) / dt), -FLICK_MAX_SPEED, FLICK_MAX_SPEED);
      vel.x = clamp(0.5 * vel.x + 0.5 * ((-dy * GRAB_SENSITIVITY) / dt), -FLICK_MAX_SPEED, FLICK_MAX_SPEED);
      grab.lastX = clientX;
      grab.lastY = clientY;
      grab.lastT = now;
      ensureLoop();
    };

    const endGrab = () => {
      const grab = grabRef.current;
      grabRef.current = null;
      if (!grab) return;
      const vel = velRef.current;
      // A pause before release means "place it down", not "flick it".
      if (performance.now() - grab.lastT > 120) {
        vel.x = 0;
        vel.y = 0;
      }
      modeRef.current = Math.hypot(vel.x, vel.y) >= FLICK_MIN_SPEED ? 'spin' : 'settle';
      ensureLoop();
    };

    const findTouch = (touches: React.TouchList, identifier: number): React.Touch | null => {
      for (let i = 0; i < touches.length; i++) {
        const touch = touches.item(i);
        if (touch && touch.identifier === identifier) return touch;
      }
      return null;
    };

    const handleInteraction = (event: React.MouseEvent | React.TouchEvent): boolean => {
      if (!activeRef.current) return false;

      if (!('touches' in event)) {
        switch (event.type) {
          case 'mousemove':
            if (grabRef.current) {
              moveGrab(event.clientX, event.clientY);
              return true;
            }
            // Don't shift the surface underneath an active screen drag.
            if ((event.buttons & 1) === 0) {
              updateTiltTarget(event.clientX, event.clientY);
            }
            return false;
          case 'mousedown':
            if (event.button !== 0) return false;
            return tryBeginGrab(event.clientX, event.clientY, -1);
          case 'mouseup':
            if (grabRef.current) {
              endGrab();
              return true;
            }
            return false;
          case 'mouseleave':
            clearTiltTarget();
            if (grabRef.current) {
              endGrab();
              return true;
            }
            return false;
        }
        return false;
      }

      const grab = grabRef.current;
      switch (event.type) {
        case 'touchstart': {
          // Extra fingers landing mid-grab stay with the grab; they must not
          // leak into the touch-injection path.
          if (grab) return true;
          if (event.touches.length !== 1) return false;
          const touch = event.changedTouches[0];
          if (!touch) return false;
          return tryBeginGrab(touch.clientX, touch.clientY, touch.identifier);
        }
        case 'touchmove': {
          if (!grab) return false;
          const touch = findTouch(event.touches, grab.pointerId);
          if (touch) moveGrab(touch.clientX, touch.clientY);
          return true;
        }
        case 'touchend':
        case 'touchcancel': {
          if (!grab) return false;
          if (!findTouch(event.touches, grab.pointerId)) endGrab();
          return true;
        }
      }
      return false;
    };

    const setFlattened = (flattened: boolean) => {
      if (flattenedRef.current === flattened) return;
      flattenedRef.current = flattened;
      if (flattened) {
        grabRef.current = null;
        tiltTargetRef.current = { x: 0, y: 0 };
        if (modeRef.current === 'grab' || modeRef.current === 'spin') modeRef.current = 'settle';
      }
      if (!isIdle() || modeRef.current !== 'rest') {
        if (modeRef.current === 'rest') modeRef.current = 'settle';
        ensureLoop();
      }
    };

    const getVideoLayoutRect = (): DOMRect | null => {
      if (!activeRef.current) return null;
      const rect = getVideoRect();
      if (!rect) return null;
      return new DOMRect(rect.left, rect.top, rect.width, rect.height);
    };

    return {
      stageRef,
      glareRef,
      backRef,
      handleInteraction,
      unprojectClient,
      getVideoLayoutRect,
      setFlattened,
    };
  }, []);

  // When 3D turns off (prop change or reduced-motion), stop the loop and
  // snap everything back to flat.
  useEffect(() => {
    if (active) return;
    if (rafRef.current !== undefined) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
    grabRef.current = null;
    modeRef.current = 'rest';
    rotRef.current = { x: 0, y: 0 };
    velRef.current = { x: 0, y: 0 };
    tiltTargetRef.current = { x: 0, y: 0 };
    const stage = stageRef.current;
    if (stage) stage.style.transform = '';
    const glare = glareRef.current;
    if (glare) glare.style.opacity = '0';
  }, [active]);

  useEffect(
    () => () => {
      if (rafRef.current !== undefined) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
    },
    [],
  );

  return { ...api, active };
};
