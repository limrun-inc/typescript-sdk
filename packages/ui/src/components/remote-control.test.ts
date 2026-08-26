// Covers `withAuthenticationToken` only — the rest of <RemoteControl> is
// integration-tested (see vitest.config.ts).
//
// Assertions parse the result and read decoded parameter values, so they
// don't depend on whether a space serializes as `+` or `%20`.

import { describe, expect, test } from 'vitest';
import { remoteControlAndroidElementTreeOptions, withAuthenticationToken } from './remote-control';

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

describe('RemoteControl Android element-tree options', () => {
  test('omits AxFetcher options by default', () => {
    expect(remoteControlAndroidElementTreeOptions('android', undefined)).toEqual({});
  });

  test('forwards explicit Android options to AxFetcher configuration', () => {
    const options = { waitForIdleTimeoutMs: 5000 };

    expect(remoteControlAndroidElementTreeOptions('android', options)).toEqual({
      androidElementTreeOptions: options,
    });
  });

  test('does not apply Android options to iOS', () => {
    expect(remoteControlAndroidElementTreeOptions('ios', { waitForIdleTimeoutMs: 5000 })).toEqual({});
  });
});
