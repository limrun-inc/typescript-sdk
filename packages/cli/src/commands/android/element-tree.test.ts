import { buildAndroidElementTreeInvocation } from './element-tree';

describe('android element-tree invocation', () => {
  it('preserves the no-option direct and daemon paths', () => {
    expect(buildAndroidElementTreeInvocation(undefined)).toEqual({
      daemonArgs: [],
    });
  });

  it('plumbs an explicit timeout to direct and daemon calls', () => {
    expect(buildAndroidElementTreeInvocation(120_000)).toEqual({
      options: { waitForIdleTimeoutMs: 120_000 },
      daemonArgs: [{ waitForIdleTimeoutMs: 120_000 }],
      daemonTimeoutMs: 132_000,
    });
  });

  it('plumbs zero without extending the daemon timeout', () => {
    expect(buildAndroidElementTreeInvocation(0)).toEqual({
      options: { waitForIdleTimeoutMs: 0 },
      daemonArgs: [{ waitForIdleTimeoutMs: 0 }],
      daemonTimeoutMs: undefined,
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 120_001])(
    'rejects invalid timeout %s',
    (timeoutMs) => {
      expect(() => buildAndroidElementTreeInvocation(timeoutMs)).toThrow(
        '--wait-for-idle-timeout-ms must be a finite non-negative integer no greater than 120000.',
      );
    },
  );

  it('documents the wait-for-idle flag and supported range', async () => {
    const { default: AndroidElementTree } = await import('./element-tree');
    expect(AndroidElementTree.flags['wait-for-idle-timeout-ms']).toMatchObject({
      description: expect.stringContaining('0-120000'),
      min: 0,
      max: 120_000,
    });
  });
});
