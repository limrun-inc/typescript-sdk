import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CONTROL_MSG_TYPE, MAC_INPUT_ACTION } from './constants';
import { MAC_TOUCH_HOLD_MS, MacPointer, type MacTouchScreen } from './mac-pointer';

// A 800 × 500 view of a 1600 × 1000 guest at the client's origin.
const screen: MacTouchScreen = {
  map: (x, y) => ({ x: x * 2, y: y * 2, width: 1600, height: 1000 }),
  contains: (x, y) => x >= 0 && x <= 800 && y >= 0 && y <= 500,
  scale: 2,
};

function setup(blocked = () => false) {
  const sent: unknown[][] = [];
  const pointer = new MacPointer((data) => {
    const view = new DataView(data);
    if (view.getUint8(0) === CONTROL_MSG_TYPE.INJECT_MOUSE_EVENT) {
      sent.push([
        'pointer',
        view.getUint8(1),
        view.getInt32(2, true),
        view.getInt32(6, true),
        view.getInt32(14, true),
      ]);
    } else {
      sent.push(['scroll', view.getFloat32(13, true), view.getFloat32(17, true)]);
    }
  }, blocked);
  return { pointer, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('a tap clicks where it landed, and only when it lifts', () => {
  const { pointer, sent } = setup();
  expect(pointer.touch('touchstart', [{ x: 100, y: 50 }], screen)).toBe(true);
  expect(sent).toEqual([]);
  pointer.touch('touchend', [], screen);
  expect(sent).toEqual([
    ['pointer', MAC_INPUT_ACTION.DOWN, 200, 100, 1],
    ['pointer', MAC_INPUT_ACTION.UP, 200, 100, 0],
  ]);
});

test('a finger that holds still presses, and one that moves drags', () => {
  const { pointer, sent } = setup();
  pointer.touch('touchstart', [{ x: 100, y: 50 }], screen);
  vi.advanceTimersByTime(MAC_TOUCH_HOLD_MS);
  expect(sent).toEqual([['pointer', MAC_INPUT_ACTION.DOWN, 200, 100, 1]]);
  pointer.touch('touchend', [], screen);
  sent.length = 0;
  pointer.touch('touchstart', [{ x: 100, y: 50 }], screen);
  pointer.touch('touchmove', [{ x: 103, y: 50 }], screen);
  expect(sent).toEqual([]);
  pointer.touch('touchmove', [{ x: 120, y: 50 }], screen);
  expect(sent).toEqual([
    ['pointer', MAC_INPUT_ACTION.DOWN, 200, 100, 1],
    ['pointer', MAC_INPUT_ACTION.MOVE, 240, 100, 1],
  ]);
});

test('a second finger landing before the press scrolls, in the guest pixels, without a click', () => {
  const { pointer, sent } = setup();
  pointer.touch('touchstart', [{ x: 100, y: 100 }], screen);
  pointer.touch(
    'touchstart',
    [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ],
    screen,
  );
  pointer.touch(
    'touchmove',
    [
      { x: 100, y: 90 },
      { x: 200, y: 90 },
    ],
    screen,
  );
  pointer.touch('touchend', [], screen);
  vi.advanceTimersByTime(MAC_TOUCH_HOLD_MS);
  expect(sent).toEqual([['scroll', 0, 20]]);
});

test('a cancelled touch clicks nothing, and off the screen nothing starts', () => {
  const { pointer, sent } = setup();
  pointer.touch('touchstart', [{ x: 100, y: 50 }], screen);
  pointer.touch('touchcancel', [], screen);
  expect(pointer.touch('touchstart', [{ x: 900, y: 50 }], screen)).toBe(false);
  vi.advanceTimersByTime(MAC_TOUCH_HOLD_MS);
  expect(sent).toEqual([]);
});

test('release lets go of a held button where it was pressed, and drops a pending finger', () => {
  const { pointer, sent } = setup();
  pointer.pointer(MAC_INPUT_ACTION.DOWN, { x: 10, y: 20, width: 1600, height: 1000 }, 1);
  pointer.touch('touchstart', [{ x: 100, y: 50 }], screen);
  pointer.release();
  vi.advanceTimersByTime(MAC_TOUCH_HOLD_MS);
  pointer.release();
  expect(sent).toEqual([
    ['pointer', MAC_INPUT_ACTION.DOWN, 10, 20, 1],
    ['pointer', MAC_INPUT_ACTION.UP, 10, 20, 0],
  ]);
});

test('blocked input sends no presses, moves or scrolls, but still lets go', () => {
  let blocked = false;
  const { pointer, sent } = setup(() => blocked);
  pointer.pointer(MAC_INPUT_ACTION.DOWN, { x: 10, y: 20, width: 1600, height: 1000 }, 1);
  blocked = true;
  pointer.pointer(MAC_INPUT_ACTION.MOVE, { x: 30, y: 20, width: 1600, height: 1000 }, 1);
  pointer.scroll({ x: 30, y: 20, width: 1600, height: 1000 }, 0, 10);
  expect(pointer.touch('touchstart', [{ x: 100, y: 50 }], screen)).toBe(false);
  pointer.release();
  expect(sent).toEqual([
    ['pointer', MAC_INPUT_ACTION.DOWN, 10, 20, 1],
    ['pointer', MAC_INPUT_ACTION.UP, 10, 20, 0],
  ]);
});
