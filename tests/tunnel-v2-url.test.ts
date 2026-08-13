import { deriveTunnelManagementURL, deriveTunnelV2URL } from '../src/internal/tunnel-v2-url';

describe('destination tunnel URL', () => {
  test('preserves the instance API path', () => {
    expect(deriveTunnelV2URL('https://node.example/v1/ios_123/api')).toBe(
      'wss://node.example/v1/ios_123/api/tunnel-v2',
    );
  });

  test('clears existing query and hash', () => {
    expect(deriveTunnelV2URL('http://node.example/v1/ios_123/api?token=old#frag')).toBe(
      'ws://node.example/v1/ios_123/api/tunnel-v2',
    );
  });

  test('rejects unsupported schemes', () => {
    expect(() => deriveTunnelV2URL('file:///v1/ios_123/api')).toThrow(
      'Unsupported apiUrl protocol for tunnel: file:',
    );
  });

  test('derives the management URL separately from the WebSocket', () => {
    expect(deriveTunnelManagementURL('https://node.example/v1/ios_123/api?token=old#frag').toString()).toBe(
      'https://node.example/v1/ios_123/api/tunnel',
    );
  });
});
