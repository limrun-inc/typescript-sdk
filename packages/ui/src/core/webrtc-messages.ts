import { AMOTION_EVENT, CONTROL_MSG_TYPE } from './constants';

export function createTouchControlMessage(
  action: number,
  pointerId: number,
  videoWidth: number,
  videoHeight: number,
  x: number,
  y: number,
  pressure = 1.0,
  actionButton = 0,
  buttons = 0,
): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT);
  offset += 1;

  // The wire protocol carries each pointer separately. Android adds pointer indices.
  const wireAction =
    action === AMOTION_EVENT.ACTION_POINTER_DOWN ? AMOTION_EVENT.ACTION_DOWN
    : action === AMOTION_EVENT.ACTION_POINTER_UP ? AMOTION_EVENT.ACTION_UP
    : action;
  view.setUint8(offset, wireAction);
  offset += 1;

  view.setBigInt64(offset, BigInt(pointerId), true);
  offset += 8;

  view.setInt32(offset, Math.round(x), true);
  offset += 4;
  view.setInt32(offset, Math.round(y), true);
  offset += 4;
  view.setUint16(offset, videoWidth, true);
  offset += 2;
  view.setUint16(offset, videoHeight, true);
  offset += 2;

  view.setInt16(offset, Math.round(pressure * 0xffff), true);
  offset += 2;

  view.setInt32(offset, actionButton, true);
  offset += 4;

  view.setInt32(offset, buttons, true);
  return buffer;
}

// iOS-specific two-finger touch control message (fixed size = 24 bytes)
// Layout (little-endian):
// 1  byte: type
// 1  byte: action
// 4  bytes: x0 (Int32)
// 4  bytes: y0 (Int32)
// 4  bytes: x1 (Int32)
// 4  bytes: y1 (Int32)
// 2  bytes: videoWidth (UInt16)
// 2  bytes: videoHeight (UInt16)
// 2  bytes: reserved (UInt16, currently 0)
export function createTwoFingerTouchControlMessage(
  action: number,
  videoWidth: number,
  videoHeight: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(24);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.INJECT_TWO_FINGER_TOUCH_EVENT);
  offset += 1;

  view.setUint8(offset, action);
  offset += 1;

  view.setInt32(offset, Math.round(x0), true);
  offset += 4;
  view.setInt32(offset, Math.round(y0), true);
  offset += 4;
  view.setInt32(offset, Math.round(x1), true);
  offset += 4;
  view.setInt32(offset, Math.round(y1), true);
  offset += 4;

  view.setUint16(offset, videoWidth, true);
  offset += 2;
  view.setUint16(offset, videoHeight, true);
  offset += 2;

  view.setUint16(offset, 0, true);
  return buffer;
}

export function createSetClipboardMessage(text: string, paste = true): ArrayBuffer {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);

  // 1 byte for type + 8 bytes for sequence + 1 byte for paste flag + 4 bytes for length + text bytes
  const buffer = new ArrayBuffer(14 + textBytes.length);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.SET_CLIPBOARD);
  offset += 1;

  // Use 0 as sequence since we don't need an acknowledgement
  view.setBigInt64(offset, BigInt(0), false);
  offset += 8;

  // Set paste flag
  view.setUint8(offset, paste ? 1 : 0);
  offset += 1;

  // Text length
  view.setUint32(offset, textBytes.length, false);
  offset += 4;

  // Text data
  new Uint8Array(buffer, offset).set(textBytes);

  return buffer;
}

export function createInjectKeycodeMessage(
  action: number,
  keycode: number,
  repeat = 0,
  metaState = 0,
): ArrayBuffer {
  const buffer = new ArrayBuffer(14);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, CONTROL_MSG_TYPE.INJECT_KEYCODE);
  offset += 1;

  view.setUint8(offset, action);
  offset += 1;

  view.setInt32(offset, keycode, true);
  offset += 4;

  view.setInt32(offset, repeat, true);
  offset += 4;

  view.setInt32(offset, metaState, true);
  return buffer;
}

// A desktop pointer event: 18 bytes. Buttons is a DOM MouseEvent.buttons mask
// (1 primary, 2 secondary, 4 auxiliary); moves carry it too, so a drag is a move
// with a button held and a hover is a move without one.
export function createMouseControlMessage(
  action: number,
  videoWidth: number,
  videoHeight: number,
  x: number,
  y: number,
  buttons: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(18);
  const view = new DataView(buffer);
  view.setUint8(0, CONTROL_MSG_TYPE.INJECT_MOUSE_EVENT);
  view.setUint8(1, action);
  view.setInt32(2, Math.round(x), true);
  view.setInt32(6, Math.round(y), true);
  view.setUint16(10, videoWidth, true);
  view.setUint16(12, videoHeight, true);
  view.setInt32(14, buttons, true);
  return buffer;
}

// A key by macOS virtual key code: 4 bytes.
export function createMacKeyMessage(action: number, keyCode: number): ArrayBuffer {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint8(0, CONTROL_MSG_TYPE.INJECT_MAC_KEY);
  view.setUint8(1, action);
  view.setUint16(2, keyCode, true);
  return buffer;
}

// A scroll at a point, in pixels of the page: 21 bytes. Positive deltaY scrolls
// content up, as DOM WheelEvent.deltaY does.
export function createMacScrollMessage(
  videoWidth: number,
  videoHeight: number,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(21);
  const view = new DataView(buffer);
  view.setUint8(0, CONTROL_MSG_TYPE.INJECT_MAC_SCROLL);
  view.setInt32(1, Math.round(x), true);
  view.setInt32(5, Math.round(y), true);
  view.setUint16(9, videoWidth, true);
  view.setUint16(11, videoHeight, true);
  view.setFloat32(13, deltaX, true);
  view.setFloat32(17, deltaY, true);
  return buffer;
}
