import { webhookConfigFromFlags } from './webhook-options';

describe('webhookConfigFromFlags', () => {
  test('returns undefined without flags', () => {
    expect(webhookConfigFromFlags({})).toBeUndefined();
  });

  test('maps url and headers', () => {
    expect(
      webhookConfigFromFlags({
        'webhook-url': 'https://ci.example.com/hooks/limrun',
        'webhook-header': ['Authorization=Bearer secret', 'X-Build=release'],
      }),
    ).toEqual({
      url: 'https://ci.example.com/hooks/limrun',
      headers: { Authorization: 'Bearer secret', 'X-Build': 'release' },
    });
  });

  test('omits headers key when none are given', () => {
    expect(webhookConfigFromFlags({ 'webhook-url': 'https://ci.example.com/h' })).toEqual({
      url: 'https://ci.example.com/h',
    });
  });

  test('preserves = in header values', () => {
    expect(
      webhookConfigFromFlags({
        'webhook-url': 'https://ci.example.com/h',
        'webhook-header': ['X-Sig=a=b=c'],
      }),
    ).toEqual({ url: 'https://ci.example.com/h', headers: { 'X-Sig': 'a=b=c' } });
  });

  test('rejects headers without a url', () => {
    expect(() => webhookConfigFromFlags({ 'webhook-header': ['A=b'] })).toThrow(
      '--webhook-header requires --webhook-url.',
    );
  });

  test('rejects entries without NAME=VALUE shape', () => {
    for (const entry of ['NoSeparator', '=value-only']) {
      expect(() =>
        webhookConfigFromFlags({ 'webhook-url': 'https://ci.example.com/h', 'webhook-header': [entry] }),
      ).toThrow('expected NAME=VALUE');
    }
  });

  test('rejects duplicate header names', () => {
    expect(() =>
      webhookConfigFromFlags({
        'webhook-url': 'https://ci.example.com/h',
        'webhook-header': ['Authorization=Bearer one', 'Authorization=Bearer two'],
      }),
    ).toThrow('Duplicate --webhook-header name "Authorization".');
  });

  test('rejects duplicate header names case-insensitively', () => {
    // Header names are case-insensitive on the wire and the daemon
    // canonicalizes them, so a different casing would still overwrite.
    expect(() =>
      webhookConfigFromFlags({
        'webhook-url': 'https://ci.example.com/h',
        'webhook-header': ['Authorization=Bearer one', 'authorization=Bearer two'],
      }),
    ).toThrow('Duplicate --webhook-header name "authorization".');
  });
});
