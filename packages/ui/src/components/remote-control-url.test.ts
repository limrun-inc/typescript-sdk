// @vitest-environment node
//
// Tests for authenticated endpoint URL construction. Assertions parse the
// result and read the decoded parameter values, so they don't depend on
// whether a space serializes as `+` or `%20`.

import { describe, expect, test } from 'vitest';
import { withAuthenticationToken } from './remote-control-url';

describe('withAuthenticationToken', () => {
  test('adds the token when the endpoint has no query string', () => {
    const result = new URL(withAuthenticationToken('wss://example.com/socket', 'instance-token'));

    expect(result.origin + result.pathname).toBe('wss://example.com/socket');
    expect(result.searchParams.get('token')).toBe('instance-token');
  });

  test('preserves query parameters already on the endpoint', () => {
    const result = new URL(
      withAuthenticationToken('wss://example.com/socket?transport=webrtc', 'instance-token'),
    );

    expect(result.searchParams.get('transport')).toBe('webrtc');
    expect(result.searchParams.get('token')).toBe('instance-token');
  });

  test('keeps a token containing URL syntax as a single decoded value', () => {
    const token = 'instance token&scope=preview';
    const result = new URL(withAuthenticationToken('wss://example.com/socket?transport=webrtc', token));

    expect(result.searchParams.get('token')).toBe(token);
    expect(result.searchParams.get('transport')).toBe('webrtc');
    expect(result.searchParams.get('scope')).toBeNull();
  });

  test('replaces an existing token instead of duplicating it', () => {
    const result = new URL(withAuthenticationToken('wss://example.com/socket?token=stale', 'fresh-token'));

    expect(result.searchParams.getAll('token')).toEqual(['fresh-token']);
  });

  test('works for the https endpoint used by the termination probe', () => {
    const result = new URL(
      withAuthenticationToken('https://example.com/socket?transport=webrtc', 'instance-token'),
    );

    expect(result.protocol).toBe('https:');
    expect(result.searchParams.get('transport')).toBe('webrtc');
    expect(result.searchParams.get('token')).toBe('instance-token');
  });
});
