import { parseAppConfigEntries, validateAppConfig } from '@limrun/api';

describe('app config helpers', () => {
  test('parses repeated entries and preserves values containing equals', () => {
    expect(parseAppConfigEntries(['PREVIEW_BUILD=true', 'DEV_LOGIN_SECRET=abc=def'])).toEqual({
      PREVIEW_BUILD: 'true',
      DEV_LOGIN_SECRET: 'abc=def',
    });
  });

  test('rejects keys carrying the APP_CONFIG_ prefix', () => {
    expect(() => parseAppConfigEntries(['APP_CONFIG_DEV_LOGIN_SECRET=1337'])).toThrow(
      'must not include the APP_CONFIG_ prefix',
    );
  });

  test('rejects keys with invalid characters', () => {
    expect(() => parseAppConfigEntries(['dev-secret=1337'])).toThrow('keys must match ^[A-Z0-9_]+$');
  });

  test('rejects malformed entries', () => {
    expect(() => parseAppConfigEntries(['SECRET'])).toThrow('expected KEY=VALUE');
  });

  test('validates config maps', () => {
    expect(() => validateAppConfig({ PREVIEW_BUILD: 'true' })).not.toThrow();
    expect(() => validateAppConfig({ APP_CONFIG_PREVIEW_BUILD: 'true' })).toThrow(
      'must not include the APP_CONFIG_ prefix',
    );
  });

  test('rejects too many entries', () => {
    const config: Record<string, string> = {};
    for (let i = 0; i < 33; i++) {
      config[`K${i}`] = 'v';
    }
    expect(() => validateAppConfig(config)).toThrow('too many app config entries');
  });

  test('rejects an oversized value', () => {
    expect(() => validateAppConfig({ SECRET: 'x'.repeat(4097) })).toThrow('is too large');
  });

  test('rejects an oversized payload', () => {
    // Each entry stays under the per-value cap; the total exceeds the payload cap.
    const config: Record<string, string> = {};
    const value = 'x'.repeat(4000);
    for (let i = 0; i < 20; i++) {
      config[`K${i}`] = value;
    }
    expect(() => validateAppConfig(config)).toThrow('payload is too large');
  });
});
