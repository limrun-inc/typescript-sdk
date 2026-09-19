/** Native iPhone Duo display metadata. Pixel geometry comes from CoreSimulator. */
export interface DuoDisplay {
  id: 'outer' | 'inner';
  screenId: number;
  trackId: string;
  width: number;
  height: number;
  scale: number;
  orientation: number;
}

export type DuoOrientation = 'portrait' | 'pud' | 'landscape-left' | 'landscape-right';

export interface DuoState {
  orientation: DuoOrientation;
  angleDegrees: number;
  minAngleDegrees: number;
  maxAngleDegrees: number;
  displays: DuoDisplay[];
}

export const DUO_DIMENSIONS = { width: 164.6, height: 117.8, depth: 5.2 } as const;

export function validHingeAngle(angle: number): boolean {
  return Number.isFinite(angle) && angle >= 0 && angle <= 180;
}

/** Mesh UVs use the native portrait panel; HID has a top-left origin. */
export function panelTouch(u: number, v: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(1, u)), y: Math.max(0, Math.min(1, 1 - v)) };
}

export function createDisplayTouchMessage(
  action: number,
  screenId: number,
  x: number,
  y: number,
): ArrayBuffer {
  if (
    !Number.isInteger(action) ||
    action < 0 ||
    action > 3 ||
    !Number.isInteger(screenId) ||
    screenId < 1 ||
    screenId > 255 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    throw new RangeError('Invalid display touch coordinates');
  }
  const message = new ArrayBuffer(12);
  const view = new DataView(message);
  view.setUint8(0, 19);
  view.setUint8(1, action);
  view.setUint8(2, screenId);
  view.setFloat32(4, x, true);
  view.setFloat32(8, y, true);
  return message;
}

/** One request in flight; intermediate slider positions are replaced by the newest position. */
export class HingeSender {
  private latest: number | undefined;
  private running = false;
  private stopped = false;
  constructor(
    private send: (angle: number) => Promise<void>,
    private failed: (error: unknown) => void,
  ) {}

  set(angle: number): void {
    if (this.stopped || !validHingeAngle(angle)) return;
    this.latest = angle;
    void this.flush();
  }

  stop(): void {
    this.stopped = true;
    this.latest = undefined;
  }

  private async flush(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.latest !== undefined && !this.stopped) {
        const angle = this.latest;
        this.latest = undefined;
        await this.send(angle);
      }
    } catch (error) {
      this.latest = undefined;
      if (!this.stopped) this.failed(error);
    } finally {
      this.running = false;
    }
  }
}
