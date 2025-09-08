import { CONTROL_MSG_TYPE } from './constants';

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

  view.setUint8(offset, action);
  offset += 1;

  view.setBigInt64(offset, BigInt(pointerId));
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
