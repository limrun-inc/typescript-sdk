import { MAX_WEBHOOK_LABELS, webhookConfigFromFlags } from './webhook-options';

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

  test('names a malformed entry by position instead of echoing the credential', () => {
    const call = () =>
      webhookConfigFromFlags({
        'webhook-url': 'https://ci.example.com/h',
        'webhook-header': ['X-Trace=abc', 'Bearer sk-live-supersecret'],
      });
    expect(call).toThrow('Invalid --webhook-header entry 2: expected NAME=VALUE.');
    expect(call).not.toThrow(/sk-live-supersecret/);
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

  describe('labels', () => {
    test('maps labels, preserving = in values and allowing empty values', () => {
      expect(
        webhookConfigFromFlags({
          'webhook-url': 'https://ci.example.com/h',
          'webhook-label': ['pipeline=release', 'query=a=b', 'flag='],
        }),
      ).toEqual({
        url: 'https://ci.example.com/h',
        labels: { pipeline: 'release', query: 'a=b', flag: '' },
      });
    });

    test('omits labels key when none are given', () => {
      expect(
        webhookConfigFromFlags({ 'webhook-url': 'https://ci.example.com/h', 'webhook-label': [] }),
      ).toEqual({ url: 'https://ci.example.com/h' });
    });

    test('rejects labels without a url', () => {
      expect(() => webhookConfigFromFlags({ 'webhook-label': ['a=b'] })).toThrow(
        '--webhook-label requires --webhook-url.',
      );
    });

    test('rejects entries without KEY=VALUE shape', () => {
      for (const entry of ['NoSeparator', '=value-only']) {
        expect(() =>
          webhookConfigFromFlags({ 'webhook-url': 'https://ci.example.com/h', 'webhook-label': [entry] }),
        ).toThrow('Invalid --webhook-label entry 1: expected KEY=VALUE.');
      }
    });

    test('rejects duplicate keys exactly, keeping distinct casings', () => {
      expect(() =>
        webhookConfigFromFlags({
          'webhook-url': 'https://ci.example.com/h',
          'webhook-label': ['env=staging', 'env=production'],
        }),
      ).toThrow('Duplicate --webhook-label key "env".');
      // Labels are JSON object keys, not header names, so casing is significant.
      expect(
        webhookConfigFromFlags({
          'webhook-url': 'https://ci.example.com/h',
          'webhook-label': ['Env=a', 'env=b'],
        }),
      ).toEqual({ url: 'https://ci.example.com/h', labels: { Env: 'a', env: 'b' } });
    });

    test('keeps object-prototype names as ordinary labels', () => {
      expect(
        webhookConfigFromFlags({
          'webhook-url': 'https://ci.example.com/h',
          'webhook-label': ['constructor=x', '__proto__=y'],
        })?.labels,
      ).toEqual(
        Object.fromEntries([
          ['constructor', 'x'],
          ['__proto__', 'y'],
        ]),
      );
    });

    test(`accepts ${MAX_WEBHOOK_LABELS} labels and rejects one more`, () => {
      const atLimit = Array.from({ length: MAX_WEBHOOK_LABELS }, (_, i) => `k${i}=v`);
      expect(
        Object.keys(
          webhookConfigFromFlags({ 'webhook-url': 'https://ci.example.com/h', 'webhook-label': atLimit })
            ?.labels ?? {},
        ),
      ).toHaveLength(MAX_WEBHOOK_LABELS);
      expect(() =>
        webhookConfigFromFlags({
          'webhook-url': 'https://ci.example.com/h',
          'webhook-label': [...atLimit, 'extra=v'],
        }),
      ).toThrow(`--webhook-label accepts at most ${MAX_WEBHOOK_LABELS} labels.`);
    });
  });
});
