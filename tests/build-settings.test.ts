import { parseBuildSettingEntries, validateBuildSettings } from '@limrun/api';

describe('build settings helpers', () => {
  test('parses verbatim keys and preserves values containing equals', () => {
    expect(
      parseBuildSettingEntries([
        'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) LIMRUN',
        'APP_CONFIG_DEV_LOGIN_SECRET=abc=def',
      ]),
    ).toEqual({
      SWIFT_ACTIVE_COMPILATION_CONDITIONS: '$(inherited) LIMRUN',
      APP_CONFIG_DEV_LOGIN_SECRET: 'abc=def',
    });
  });

  test('does not enforce the allowlist (server is authoritative)', () => {
    // A non-allowlisted key is structurally valid client-side; the server
    // rejects it. The client must not block it.
    expect(() => validateBuildSettings({ INFOPLIST_PREPROCESSOR_DEFINITIONS: 'DEBUG=1' })).not.toThrow();
  });

  test('rejects structurally invalid keys', () => {
    expect(() => parseBuildSettingEntries(['dev-login-secret=1337'])).toThrow('must match ^[A-Z0-9_]+$');
  });

  test('rejects malformed entries', () => {
    expect(() => parseBuildSettingEntries(['APP_CONFIG_SECRET'])).toThrow('expected KEY=VALUE');
  });

  test('rejects too many entries', () => {
    const settings: Record<string, string> = {};
    for (let i = 0; i < 33; i++) {
      settings[`APP_CONFIG_K${i}`] = 'v';
    }
    expect(() => validateBuildSettings(settings)).toThrow('too many build settings');
  });

  test('rejects an oversized value', () => {
    expect(() => validateBuildSettings({ APP_CONFIG_SECRET: 'x'.repeat(4097) })).toThrow('is too large');
  });

  test('rejects an oversized payload', () => {
    // Each entry stays under the per-value cap; the total exceeds the payload cap.
    const settings: Record<string, string> = {};
    const value = 'x'.repeat(4000);
    for (let i = 0; i < 20; i++) {
      settings[`APP_CONFIG_K${i}`] = value;
    }
    expect(() => validateBuildSettings(settings)).toThrow('payload is too large');
  });
});
