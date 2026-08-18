// Covers `withAuthenticationToken` only — the rest of <RemoteControl> is
// integration-tested (see vitest.config.ts).
//
// Assertions parse the result and read decoded parameter values, so they
// don't depend on whether a space serializes as `+` or `%20`.

import { describe, expect, test } from 'vitest';
import { isMicrophoneCaptureWanted } from './microphone-demand';
import { withAuthenticationToken } from './remote-control';

describe('withAuthenticationToken', () => {
  test('adds the token alongside query parameters already on the endpoint', () => {
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
});

describe('isMicrophoneCaptureWanted', () => {
  test('keeps capture active for either manual enablement or guest demand', () => {
    expect(isMicrophoneCaptureWanted(false, false)).toBe(false);
    expect(isMicrophoneCaptureWanted(true, false)).toBe(true);
    expect(isMicrophoneCaptureWanted(false, true)).toBe(true);
    expect(isMicrophoneCaptureWanted(true, true)).toBe(true);
  });
});
