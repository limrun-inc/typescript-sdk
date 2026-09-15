import { decodeConnectionHeader, encodeConnectionHeader } from '../src/tunnel';

describe('tunnel connection header', () => {
  test('round trips uint32 values', () => {
    for (const connId of [1, 255, 256, 65535, 0xffffffff]) {
      expect(decodeConnectionHeader(encodeConnectionHeader(connId))).toBe(connId);
    }
  });
});
