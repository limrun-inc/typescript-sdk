import { expect, test } from 'vitest';
import { CONTROL_MSG_TYPE, MAC_INPUT_ACTION } from './constants';
import { macKeyCodeFor } from './mac-keys';
import { detectPlatform } from './stream-utils';
import { createMacKeyMessage, createMacScrollMessage, createMouseControlMessage } from './webrtc-messages';

test('detects a macOS instance by its ID prefix', () => {
  expect(detectPlatform('wss://node.example/v1/macos_eu_01h/endpointWebSocket')).toBe('macos');
  expect(detectPlatform('wss://node.example/v1/android_eu_01h/endpointWebSocket')).toBe('android');
  expect(detectPlatform('wss://node.example/v1/ios_eu_01h/endpointWebSocket')).toBe('ios');
});

test('encodes a desktop pointer event with its button mask', () => {
  const view = new DataView(createMouseControlMessage(MAC_INPUT_ACTION.MOVE, 1920, 1080, 960.4, 540.6, 2));
  expect(view.byteLength).toBe(18);
  expect(view.getUint8(0)).toBe(CONTROL_MSG_TYPE.INJECT_MOUSE_EVENT);
  expect(view.getUint8(1)).toBe(MAC_INPUT_ACTION.MOVE);
  expect(view.getInt32(2, true)).toBe(960);
  expect(view.getInt32(6, true)).toBe(541);
  expect(view.getUint16(10, true)).toBe(1920);
  expect(view.getUint16(12, true)).toBe(1080);
  expect(view.getInt32(14, true)).toBe(2);
});

test('encodes a key by macOS virtual key code', () => {
  const view = new DataView(createMacKeyMessage(MAC_INPUT_ACTION.UP, 0x37));
  expect(view.byteLength).toBe(4);
  expect(view.getUint8(0)).toBe(CONTROL_MSG_TYPE.INJECT_MAC_KEY);
  expect(view.getUint8(1)).toBe(MAC_INPUT_ACTION.UP);
  expect(view.getUint16(2, true)).toBe(0x37);
});

test('encodes a scroll as pixel deltas at a point', () => {
  const view = new DataView(createMacScrollMessage(1920, 1080, 100, 200, -1.5, 48));
  expect(view.byteLength).toBe(21);
  expect(view.getUint8(0)).toBe(CONTROL_MSG_TYPE.INJECT_MAC_SCROLL);
  expect(view.getInt32(1, true)).toBe(100);
  expect(view.getInt32(5, true)).toBe(200);
  expect(view.getUint16(9, true)).toBe(1920);
  expect(view.getUint16(11, true)).toBe(1080);
  expect(view.getFloat32(13, true)).toBe(-1.5);
  expect(view.getFloat32(17, true)).toBe(48);
});

test('maps physical keys, modifiers included, to macOS virtual key codes', () => {
  expect(macKeyCodeFor('KeyA')).toBe(0x00);
  expect(macKeyCodeFor('Enter')).toBe(0x24);
  expect(macKeyCodeFor('MetaLeft')).toBe(0x37);
  expect(macKeyCodeFor('ShiftLeft')).toBe(0x38);
  expect(macKeyCodeFor('ArrowDown')).toBe(0x7d);
  expect(macKeyCodeFor('NotAKey')).toBeUndefined();
});
