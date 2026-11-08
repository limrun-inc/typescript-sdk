import { describe, expect, it } from 'vitest';
import { tokenRequiresWatchOnly } from './remote-control-permissions';

const tokenFor = (scopes: unknown) =>
  `lim_st_${btoa('{"alg":"EdDSA"}')}.${btoa(JSON.stringify({ scopes }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')}.signature`;

const iosId = 'ios_euna_01h455vb4pex5vsknk084sn02q';
const androidId = 'android_euna_01h455vb4pex5vsknk084sn02q';
const url = `wss://example.com/${iosId}/ws`;

describe('RemoteControl token permissions', () => {
  it.each([
    [[`ios:${iosId}:watch`], true],
    [['ios:*:watch'], true],
    [['*:*:watch'], true],
    [[`*:${iosId}:watch`], true],
    [[`ios:${iosId}:watch`, `ios:${iosId}:read`], true],
    [[`ios:${iosId}:watch`, 'ios:ios_other:stream', 'android:*:all'], true],
    [[`ios:${iosId}:watch`, `ios:${iosId}:stream`], false],
    [[`ios:${iosId}:watch`, 'ios:*:stream'], false],
    [[`ios:${iosId}:watch`, '*:*:all'], false],
    [['*:*:watch', `*:${iosId}:all`], false],
    [['ios:*:stream'], false],
    [[`ios:${iosId}:read`], false],
    [['ios:ios_other:watch'], false],
    [['android:*:watch'], false],
    [['ios:*:watch:extra'], false],
    [[], false],
    [null, false],
    ['ios:*:watch', false],
    [[null, 'ios:*:watch'], false],
  ])('matches device grants in %j', (scopes, expected) => {
    expect(tokenRequiresWatchOnly(url, tokenFor(scopes))).toBe(expected);
  });

  it('matches Android grants without treating iOS control as Android control', () => {
    const token = tokenFor([`android:${androidId}:watch`, 'ios:*:all']);
    expect(tokenRequiresWatchOnly(`wss://example.com/${androidId}/ws`, token)).toBe(true);
  });

  it('uses the decoded URL path, ignoring query parameters and other device IDs', () => {
    const token = tokenFor([`ios:${iosId}:watch`]);
    expect(tokenRequiresWatchOnly(`wss://example.com/${iosId.replace('ios_', 'ios%5F')}/ws`, token)).toBe(
      true,
    );
    expect(tokenRequiresWatchOnly(`wss://example.com/ws?instance=${iosId}`, token)).toBe(false);
    expect(tokenRequiresWatchOnly('wss://example.com/ios_other/ws', token)).toBe(false);
  });

  it.each([
    'secret',
    'lim_opaque',
    'lim_st_bad',
    'lim_st_a.!.b',
    'lim_st_a.b.b',
    tokenFor(['ios:*:watch']).replace('.signature', '.'),
  ])('leaves opaque or malformed tokens to server authentication: %s', (token) =>
    expect(tokenRequiresWatchOnly(url, token)).toBe(false),
  );

  it('keeps the explicit prop behavior when the URL does not identify a device', () => {
    const token = tokenFor(['ios:*:watch']);
    expect(tokenRequiresWatchOnly('wss://proxy/stream', token)).toBe(false);
    expect(tokenRequiresWatchOnly('not a URL', token)).toBe(false);
  });
});
