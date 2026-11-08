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

/** Select the panel used by a single-display viewer at the current hinge angle. */
export function getDuoDisplay(state: DuoState | null | undefined): DuoDisplay | undefined {
  return state?.displays.find((display) => display.id === (state.angleDegrees < 90 ? 'outer' : 'inner'));
}

/** Quarter turns of a native display, independent of the surrounding device frame. */
export function duoDisplayTurns(orientation: number | undefined): 0 | 1 | 2 | 3 {
  return (
    orientation === 2 ? 2
    : orientation === 3 ? 1
    : orientation === 4 ? 3
    : 0
  );
}

/** Keep a gesture on its starting panel and release it before the view changes. */
export class DuoTouchController {
  private screenId: number | undefined;
  private turns = 0;
  private held: { screenId: number; x: number; y: number } | undefined;

  constructor(private send: (action: number, screenId: number, x: number, y: number) => void) {}

  get active(): boolean {
    return this.held !== undefined;
  }

  setDisplay(
    display: Pick<DuoDisplay, 'screenId' | 'orientation'> | undefined,
    turns: number = duoDisplayTurns(display?.orientation),
  ): void {
    if (this.screenId !== display?.screenId || this.turns !== turns) this.release();
    this.screenId = display?.screenId;
    this.turns = turns;
  }

  /** Coordinates are normalized; native input already accounts for the viewer's rotation. */
  touch(phase: 'begin' | 'move' | 'end', x: number, y: number, native = false): void {
    if (this.screenId === undefined) return;
    const point = flatDisplayTouch(x, y, native ? 0 : this.turns);
    if (phase === 'begin') {
      this.release();
      this.held = { screenId: this.screenId, ...point };
    }
    if (!this.held) return;
    Object.assign(this.held, point);
    if (phase === 'end') this.release();
    else this.send(phase === 'begin' ? 0 : 2, this.held.screenId, point.x, point.y);
  }

  /** Call on pointer cancellation, lost capture, disconnect, and viewer disposal. */
  release(): void {
    if (!this.held) return;
    const { screenId, x, y } = this.held;
    this.held = undefined;
    this.send(1, screenId, x, y);
  }
}

export const DUO_DIMENSIONS = { width: 164.6, height: 117.8, depth: 5.2 } as const;

/** Invert the CSS display rotation before sending native panel coordinates. */
export function flatDisplayTouch(x: number, y: number, turns: number): { x: number; y: number } {
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  if (turns === 1) return { x: y, y: 1 - x };
  if (turns === 2) return { x: 1 - x, y: 1 - y };
  if (turns === 3) return { x: 1 - y, y: x };
  return { x, y };
}

export function validHingeAngle(angle: number): boolean {
  return Number.isFinite(angle) && angle >= 0 && angle <= 180;
}

/** Mesh UVs use the native portrait panel; HID has a top-left origin. */
export function panelTouch(u: number, v: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(1, u)), y: Math.max(0, Math.min(1, 1 - v)) };
}

/** Locking the view never suppresses screen input, including accidental Alt presses. */
export function duoPointerMode(
  locked: boolean,
  screenHit: boolean,
  altKey: boolean,
): 'touch' | 'orbit' | 'ignore' {
  if (screenHit && (locked || !altKey)) return 'touch';
  return locked ? 'ignore' : 'orbit';
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

export type DuoButton = 'side' | 'volumeUp' | 'volumeDown';
export const DUO_BUTTONS: Record<DuoButton, string> = {
  side: 'Sleep/Wake',
  volumeUp: 'Volume Up',
  volumeDown: 'Volume Down',
};

/** Keeps button edges ordered, including releases after cancellation or a failed press. */
export class DuoButtonSender {
  private held?: DuoButton;
  private tail = Promise.resolve();
  private timeout?: ReturnType<typeof setTimeout>;
  constructor(
    private send: (button: DuoButton, down: boolean) => Promise<void>,
    private failed: (error: unknown) => void,
  ) {}
  press(button: DuoButton): void {
    if (this.held) return;
    this.held = button;
    this.enqueue(button, true);
    this.timeout = setTimeout(() => this.release(), 10000);
  }
  release(): void {
    if (!this.held) return;
    clearTimeout(this.timeout);
    const button = this.held;
    this.held = undefined;
    this.enqueue(button, false);
  }
  private enqueue(button: DuoButton, down: boolean): void {
    this.tail = this.tail.then(() => this.send(button, down)).catch(this.failed);
  }
}
