import { deriveReverseTunnelUrl } from '../src/ios-client';
import { decodeConnectionHeader, encodeConnectionHeader } from '../src/tunnel';

describe('reverse tunnel helpers', () => {
  test('deriveReverseTunnelUrl preserves the iOS api path', () => {
    expect(deriveReverseTunnelUrl('https://node.example/v1/ios_123/api', 8081)).toBe(
      'wss://node.example/v1/ios_123/api/reverse-tunnel?remotePort=8081',
    );
  });

  test('deriveReverseTunnelUrl clears existing query and hash', () => {
    expect(deriveReverseTunnelUrl('http://node.example/v1/ios_123/api?token=old#frag', 8099)).toBe(
      'ws://node.example/v1/ios_123/api/reverse-tunnel?remotePort=8099',
    );
  });

  test('connection header round trips uint32 values', () => {
    for (const connId of [1, 255, 256, 65535, 0xffffffff]) {
      expect(decodeConnectionHeader(encodeConnectionHeader(connId))).toBe(connId);
    }
  });
});
