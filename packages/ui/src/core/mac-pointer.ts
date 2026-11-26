import { MAC_INPUT_ACTION } from './constants';
import { createMacScrollMessage, createMouseControlMessage } from './webrtc-messages';

/** A point on a macOS guest's screen, in its pixels, with the screen's size. */
export interface MacScreenPoint {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a touch screen's fingers land on the guest's screen, from client coordinates. */
export interface MacTouchScreen {
  /** The guest's point under a client point. */
  map(x: number, y: number): MacScreenPoint | undefined;
  /** Whether a client point is on the guest's screen, not on a frame or a letterbox bar. */
  contains(x: number, y: number): boolean;
  /** Guest pixels per CSS pixel, so content follows the fingers. */
  scale: number;
}

export type MacTouchType = 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel';

// A finger presses once it has held still this long, in milliseconds, or moved this far, in CSS
// pixels; a second finger landing sooner makes the gesture a scroll instead.
export const MAC_TOUCH_HOLD_MS = 150;
export const MAC_TOUCH_SLOP = 8;

type Gesture = {
  mode: 'pending' | 'press' | 'scroll';
  x: number;
  y: number;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * MacPointer is the one sender of a macOS guest's pointer. Every view sends its mouse, touch and
 * scroll input through it, so it knows which button the guest holds and can let go of it when input
 * moves to another view, the stream goes away, or input is blocked.
 *
 * A touch screen has no hover and no wheel. One finger presses the left button and drags with it
 * held, and lets go where it lifts; limacvm rests the pointer at a new spot before a press, as macOS
 * needs. The press waits until the finger moves, holds still a moment, or lifts as a tap, so a second
 * finger landing just after it scrolls without a click. Two fingers scroll, content following them
 * as on a trackpad. A gesture that becomes a scroll lets its press go first, and stays a scroll until
 * every finger lifts. A cancelled touch, which the system took for its own gesture, is no tap.
 */
export class MacPointer {
  // The last pointer event sent, whose buttons the guest holds.
  private last: (MacScreenPoint & { buttons: number }) | undefined;
  private gesture: Gesture | undefined;
  private screen: MacTouchScreen | undefined;

  constructor(
    private send: (data: ArrayBuffer) => void,
    /** Input is blocked, as in inspect's select mode. A release of a button the guest holds still goes out. */
    private blocked: () => boolean = () => false,
  ) {}

  pointer(action: number, point: MacScreenPoint, buttons: number): void {
    // A release goes out only for a button the guest holds: one whose press was blocked has nothing
    // to let go of.
    const releasesHeld = action === MAC_INPUT_ACTION.UP && !!this.last?.buttons;
    if (this.blocked() && !releasesHeld) return;
    this.last = { ...point, buttons };
    this.send(createMouseControlMessage(action, point.width, point.height, point.x, point.y, buttons));
  }

  scroll(point: MacScreenPoint, deltaX: number, deltaY: number): void {
    if (this.blocked()) return;
    this.send(createMacScrollMessage(point.width, point.height, point.x, point.y, deltaX, deltaY));
  }

  /**
   * A touch event, its fingers in client coordinates. Returns true when a finger lands on the screen
   * and starts a gesture, so the caller can give the screen the keyboard.
   */
  touch(type: MacTouchType, touches: { x: number; y: number }[], screen: MacTouchScreen): boolean {
    const current = this.gesture;
    if (touches.length >= 2) {
      const center = {
        x: touches.reduce((sum, t) => sum + t.x, 0) / touches.length,
        y: touches.reduce((sum, t) => sum + t.y, 0) / touches.length,
      };
      if (current?.mode === 'scroll') {
        const point = screen.map(center.x, center.y);
        if (point && type === 'touchmove') {
          this.scroll(point, (current.x - center.x) * screen.scale, (current.y - center.y) * screen.scale);
        }
      } else if (current?.mode === 'press') {
        this.lift(current, screen);
      } else if (current?.mode === 'pending') {
        clearTimeout(current.timer);
      }
      this.gesture = { mode: 'scroll', ...center };
      return false;
    }
    const finger = touches[0];
    if (finger && type === 'touchstart' && !current) {
      if (this.blocked() || !screen.contains(finger.x, finger.y)) return false;
      this.screen = screen;
      this.gesture = {
        mode: 'pending',
        x: finger.x,
        y: finger.y,
        timer: setTimeout(() => this.press(), MAC_TOUCH_HOLD_MS),
      };
      return true;
    }
    if (finger && current?.mode === 'pending') {
      if (Math.hypot(finger.x - current.x, finger.y - current.y) < MAC_TOUCH_SLOP) return false;
      this.press();
    }
    if (finger && this.gesture?.mode === 'press') {
      this.gesture = { mode: 'press', x: finger.x, y: finger.y };
      const point = screen.map(finger.x, finger.y);
      if (point) this.pointer(MAC_INPUT_ACTION.MOVE, point, 1);
      return false;
    }
    if (touches.length === 0) {
      if (current?.mode === 'pending') {
        if (type === 'touchcancel') clearTimeout(current.timer);
        else this.press();
      }
      const pressed = this.gesture;
      if (pressed?.mode === 'press') this.lift(pressed, screen);
      this.gesture = undefined;
    }
    return false;
  }

  /** Drops a pending touch and lets go of any button the guest holds, where it was pressed. */
  release(): void {
    clearTimeout(this.gesture?.timer);
    this.gesture = undefined;
    const last = this.last;
    if (last?.buttons) this.pointer(MAC_INPUT_ACTION.UP, last, 0);
  }

  // A pending finger's press, where it landed.
  private press(): void {
    const current = this.gesture;
    if (current?.mode !== 'pending') return;
    clearTimeout(current.timer);
    this.gesture = { mode: 'press', x: current.x, y: current.y };
    const point = this.screen?.map(current.x, current.y);
    if (point) this.pointer(MAC_INPUT_ACTION.DOWN, point, 1);
  }

  private lift(at: { x: number; y: number }, screen: MacTouchScreen): void {
    const point = screen.map(at.x, at.y);
    if (point) this.pointer(MAC_INPUT_ACTION.UP, point, 0);
  }
}
