import { deriveDestinationTunnelURL } from '../src/internal/destination-tunnel-url';

describe('destination tunnel URL', () => {
  test('preserves the instance API path', () => {
    expect(deriveDestinationTunnelURL('https://node.example/v1/ios_123/api')).toBe(
      'wss://node.example/v1/ios_123/api/tunnel',
    );
  });

  test('clears existing query and hash', () => {
    expect(deriveDestinationTunnelURL('http://node.example/v1/ios_123/api?token=old#frag')).toBe(
      'ws://node.example/v1/ios_123/api/tunnel',
    );
  });

  test('rejects unsupported schemes', () => {
    expect(() => deriveDestinationTunnelURL('file:///v1/ios_123/api')).toThrow(
      'Unsupported apiUrl protocol for tunnel: file:',
    );
  });
});
