// Pure orientation dynamics for the 3D device view.
//
// This module owns the "feel" of the interaction described in the product
// blog post: the device subtly turns to face the cursor, can be grabbed and
// rotated, keeps spinning when flicked, and gently settles back to face the
// viewer. It is deliberately free of three.js / DOM dependencies so the
// dynamics can be unit-tested in a plain node environment.
//
// Conventions:
//   - `yaw` is rotation about the world Y axis (positive turns the device's
//     face toward the viewer's right).
//   - `pitch` is rotation about the X axis (positive tips the face downward,
//     matching screen-space "cursor below center").
//   - All angles are radians, all velocities are radians/second.

export interface SpinTarget {
  yaw: number;
  pitch: number;
}

export type SpinMode =
  // At rest / following the cursor-tilt target with a critically damped
  // spring. This is the default mode.
  | 'rest'
  // The user is actively dragging; orientation follows the pointer 1:1 and
  // a running velocity estimate is kept for the release flick.
  | 'dragging'
  // Post-flick free spin. Velocity decays exponentially until it is slow
  // enough to hand off back to 'rest'.
  | 'inertia';

export interface SpinState {
  yaw: number;
  pitch: number;
  yawVelocity: number;
  pitchVelocity: number;
  mode: SpinMode;
}

// Pitch is clamped so the device can never gimbal over the top; spinning is
// primarily a yaw (turntable) motion, like flicking a real phone held by its
// edges.
export const MAX_PITCH = (75 * Math.PI) / 180;

// Flicks slower than this don't enter inertia at all — the release feels
// like letting go, not throwing.
const MIN_FLICK_SPEED = 0.9; // rad/s

// While spinning freely, hand back to the settle spring once the spin has
// decayed below this speed.
const SETTLE_HANDOFF_SPEED = 1.4; // rad/s

// Exponential decay rate of a free spin. ~1.05 means a flick loses about
// 65% of its speed per second — fast spins visibly coast for a couple of
// seconds before settling.
const SPIN_DAMPING = 1.05; // 1/s

// Natural frequency of the critically damped settle spring. ~6 rad/s
// settles in roughly a second without overshoot.
const SETTLE_OMEGA = 6; // rad/s

// Time constant for the exponential moving average used to estimate drag
// velocity. Short enough to capture a flick, long enough to ignore jitter.
const VELOCITY_SMOOTHING_TAU = 0.04; // s

// Integration substep ceiling. Large dt values (tab switch, long GC pause)
// are integrated in slices so the spring never explodes.
const MAX_SUBSTEP = 1 / 30; // s

// Total dt ceiling — after a long pause we simulate at most this much time
// rather than fast-forwarding the whole gap.
const MAX_STEP = 0.25; // s

export const createSpinState = (): SpinState => ({
  yaw: 0,
  pitch: 0,
  yawVelocity: 0,
  pitchVelocity: 0,
  mode: 'rest',
});

// Wrap an angle to [-PI, PI).
export const wrapAngle = (angle: number): number => {
  let a = (angle + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min
  : value > max ? max
  : value;

/**
 * Map a pointer position (normalized to [-1, 1] relative to the canvas
 * center; +x right, +y down) to the orientation the device should ease
 * toward so it appears to turn and face the cursor.
 */
export const tiltTargetFromPointer = (nx: number, ny: number, maxTilt: number): SpinTarget => ({
  yaw: clamp(nx, -1, 1) * maxTilt,
  pitch: clamp(ny, -1, 1) * maxTilt,
});

export const beginDrag = (state: SpinState): void => {
  state.mode = 'dragging';
  state.yawVelocity = 0;
  state.pitchVelocity = 0;
};

/**
 * Apply one pointer-move sample while dragging. `deltaYaw` / `deltaPitch`
 * are the orientation change for this sample (the caller converts pixels to
 * radians); `dtSeconds` is the time since the previous sample and feeds the
 * release-velocity estimate.
 */
export const applyDrag = (
  state: SpinState,
  deltaYaw: number,
  deltaPitch: number,
  dtSeconds: number,
): void => {
  if (state.mode !== 'dragging') return;
  state.yaw += deltaYaw;
  state.pitch = clamp(state.pitch + deltaPitch, -MAX_PITCH, MAX_PITCH);

  if (dtSeconds > 0) {
    const alpha = 1 - Math.exp(-dtSeconds / VELOCITY_SMOOTHING_TAU);
    state.yawVelocity += (deltaYaw / dtSeconds - state.yawVelocity) * alpha;
    state.pitchVelocity += (deltaPitch / dtSeconds - state.pitchVelocity) * alpha;
  }
};

/**
 * Release the drag. A fast release becomes a free spin (inertia); a slow one
 * goes straight back to the settle spring.
 */
export const endDrag = (state: SpinState): void => {
  if (state.mode !== 'dragging') return;
  const speed = Math.hypot(state.yawVelocity, state.pitchVelocity);
  if (speed >= MIN_FLICK_SPEED) {
    state.mode = 'inertia';
  } else {
    state.mode = 'rest';
    state.yawVelocity = 0;
    state.pitchVelocity = 0;
  }
};

const stepRest = (state: SpinState, target: SpinTarget, dt: number): void => {
  // Critically damped spring: x'' = -omega^2 (x - target) - 2 omega x'.
  // Semi-implicit Euler keeps it stable at our substep sizes.
  const yawAccel =
    -SETTLE_OMEGA * SETTLE_OMEGA * (state.yaw - target.yaw) - 2 * SETTLE_OMEGA * state.yawVelocity;
  const pitchAccel =
    -SETTLE_OMEGA * SETTLE_OMEGA * (state.pitch - target.pitch) - 2 * SETTLE_OMEGA * state.pitchVelocity;
  state.yawVelocity += yawAccel * dt;
  state.pitchVelocity += pitchAccel * dt;
  state.yaw += state.yawVelocity * dt;
  state.pitch += state.pitchVelocity * dt;
};

const stepInertia = (state: SpinState, target: SpinTarget, dt: number): void => {
  const decay = Math.exp(-SPIN_DAMPING * dt);
  state.yawVelocity *= decay;
  state.pitchVelocity *= decay;
  state.yaw += state.yawVelocity * dt;
  state.pitch += state.pitchVelocity * dt;
  if (state.pitch <= -MAX_PITCH || state.pitch >= MAX_PITCH) {
    state.pitch = clamp(state.pitch, -MAX_PITCH, MAX_PITCH);
    state.pitchVelocity = 0;
  }

  if (Math.hypot(state.yawVelocity, state.pitchVelocity) < SETTLE_HANDOFF_SPEED) {
    // Hand off to the settle spring. Re-express yaw as the nearest
    // coterminal angle to the target so a device that did three full turns
    // settles forward, not by unwinding three revolutions.
    state.yaw = target.yaw + wrapAngle(state.yaw - target.yaw);
    state.mode = 'rest';
  }
};

/**
 * Advance the simulation by `dtSeconds` toward `target` (the cursor-tilt
 * orientation). No-op while dragging — the pointer owns the orientation.
 */
export const stepSpin = (state: SpinState, target: SpinTarget, dtSeconds: number): void => {
  if (state.mode === 'dragging') return;
  let remaining = clamp(dtSeconds, 0, MAX_STEP);
  while (remaining > 0) {
    const dt = Math.min(remaining, MAX_SUBSTEP);
    remaining -= dt;
    if (state.mode === 'inertia') {
      stepInertia(state, target, dt);
    } else {
      stepRest(state, target, dt);
    }
  }
};

/**
 * True when the device is visually at rest on target — used to skip
 * re-renders when nothing is moving.
 */
export const isSettled = (state: SpinState, target: SpinTarget, epsilon = 1e-4): boolean =>
  state.mode === 'rest' &&
  Math.abs(state.yaw - target.yaw) < epsilon &&
  Math.abs(state.pitch - target.pitch) < epsilon &&
  Math.abs(state.yawVelocity) < epsilon &&
  Math.abs(state.pitchVelocity) < epsilon;
