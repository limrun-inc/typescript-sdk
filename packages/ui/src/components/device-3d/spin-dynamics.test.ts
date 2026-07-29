// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  MAX_PITCH,
  applyDrag,
  beginDrag,
  createSpinState,
  endDrag,
  isSettled,
  stepSpin,
  tiltTargetFromPointer,
  wrapAngle,
  SpinState,
  SpinTarget,
} from './spin-dynamics';

const FRONT: SpinTarget = { yaw: 0, pitch: 0 };

// Run the simulation at a fixed 60Hz for `seconds`.
const simulate = (state: SpinState, target: SpinTarget, seconds: number) => {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    stepSpin(state, target, dt);
  }
};

// Drive a drag as a series of pointer samples, each `dYaw`/`dPitch` radians
// apart at `hz` samples per second.
const drag = (state: SpinState, dYaw: number, dPitch: number, samples: number, hz = 120) => {
  beginDrag(state);
  for (let i = 0; i < samples; i++) {
    applyDrag(state, dYaw, dPitch, 1 / hz);
  }
};

describe('wrapAngle', () => {
  it('wraps to [-PI, PI)', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(wrapAngle(Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapAngle(2 * Math.PI)).toBeCloseTo(0);
    expect(wrapAngle(-Math.PI / 4)).toBeCloseTo(-Math.PI / 4);
    expect(wrapAngle(7 * Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1);
  });
});

describe('tiltTargetFromPointer', () => {
  it('turns toward the cursor proportionally', () => {
    const t = tiltTargetFromPointer(0.5, -1, 0.2);
    expect(t.yaw).toBeCloseTo(0.1);
    expect(t.pitch).toBeCloseTo(-0.2);
  });

  it('clamps pointer coordinates outside the canvas', () => {
    const t = tiltTargetFromPointer(4, -7, 0.2);
    expect(t.yaw).toBeCloseTo(0.2);
    expect(t.pitch).toBeCloseTo(-0.2);
  });

  it('is centered at zero', () => {
    const t = tiltTargetFromPointer(0, 0, 0.2);
    expect(t.yaw).toBe(0);
    expect(t.pitch).toBe(0);
  });
});

describe('dragging', () => {
  it('follows the pointer 1:1 while dragging', () => {
    const s = createSpinState();
    drag(s, 0.01, 0.005, 50);
    expect(s.mode).toBe('dragging');
    expect(s.yaw).toBeCloseTo(0.5);
    expect(s.pitch).toBeCloseTo(0.25);
  });

  it('clamps pitch so the device cannot flip over the top', () => {
    const s = createSpinState();
    drag(s, 0, 0.05, 200);
    expect(s.pitch).toBeLessThanOrEqual(MAX_PITCH);
    expect(s.pitch).toBeCloseTo(MAX_PITCH);
  });

  it('ignores steps while dragging (pointer owns the orientation)', () => {
    const s = createSpinState();
    drag(s, 0.01, 0, 10);
    const yawBefore = s.yaw;
    stepSpin(s, FRONT, 1 / 60);
    expect(s.yaw).toBe(yawBefore);
  });
});

describe('release', () => {
  it('a slow release goes straight to rest with no residual velocity', () => {
    const s = createSpinState();
    // ~0.06 rad/s — far below the flick threshold.
    drag(s, 0.0005, 0, 20);
    endDrag(s);
    expect(s.mode).toBe('rest');
    expect(s.yawVelocity).toBe(0);
    expect(s.pitchVelocity).toBe(0);
  });

  it('a fast flick enters inertia and keeps spinning past the release point', () => {
    const s = createSpinState();
    // ~6 rad/s of yaw at release.
    drag(s, 0.05, 0, 30);
    endDrag(s);
    expect(s.mode).toBe('inertia');
    const yawAtRelease = s.yaw;
    simulate(s, FRONT, 0.5);
    expect(s.yaw).toBeGreaterThan(yawAtRelease + 0.5);
  });

  it('a flick decays and gently settles back to face front', () => {
    const s = createSpinState();
    drag(s, 0.05, 0, 30);
    endDrag(s);
    simulate(s, FRONT, 8);
    expect(s.mode).toBe('rest');
    expect(isSettled(s, FRONT, 1e-3)).toBe(true);
  });

  it('settles via the shortest path after multiple full revolutions', () => {
    const s = createSpinState();
    // Spin hard: ends up many radians of yaw plus high velocity.
    drag(s, 0.15, 0, 60);
    endDrag(s);
    simulate(s, FRONT, 12);
    // Settles to exactly 0 (front), not to some multiple of 2*PI.
    expect(Math.abs(s.yaw)).toBeLessThan(1e-3);
    expect(Math.abs(s.pitch)).toBeLessThan(1e-3);
  });
});

describe('stepSpin (rest / cursor follow)', () => {
  it('eases toward the tilt target without overshooting', () => {
    const s = createSpinState();
    const target = tiltTargetFromPointer(1, 0.5, 0.15);
    let maxYaw = 0;
    const dt = 1 / 60;
    for (let t = 0; t < 3; t += dt) {
      stepSpin(s, target, dt);
      maxYaw = Math.max(maxYaw, s.yaw);
    }
    expect(s.yaw).toBeCloseTo(target.yaw, 3);
    expect(s.pitch).toBeCloseTo(target.pitch, 3);
    // Critically damped: no meaningful overshoot past the target.
    expect(maxYaw).toBeLessThanOrEqual(target.yaw + 1e-3);
  });

  it('survives a huge dt (tab switch) without exploding', () => {
    const s = createSpinState();
    drag(s, 0.05, 0.02, 30);
    endDrag(s);
    stepSpin(s, FRONT, 10);
    expect(Number.isFinite(s.yaw)).toBe(true);
    expect(Number.isFinite(s.pitch)).toBe(true);
    expect(Math.abs(s.pitch)).toBeLessThanOrEqual(MAX_PITCH);
  });

  it('is a no-op at dt=0', () => {
    const s = createSpinState();
    s.yaw = 0.3;
    stepSpin(s, FRONT, 0);
    expect(s.yaw).toBe(0.3);
  });

  it('reports settled only when on target and still', () => {
    const s = createSpinState();
    expect(isSettled(s, FRONT)).toBe(true);
    expect(isSettled(s, { yaw: 0.1, pitch: 0 })).toBe(false);
    s.yawVelocity = 0.5;
    expect(isSettled(s, FRONT)).toBe(false);
  });
});
