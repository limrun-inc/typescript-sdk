import type { XcodeInstanceCache } from '@limrun/api';
import {
  formatBytes,
  parseCacheConfig,
  restoreOutcome,
  restoreProgressLine,
  saveOutcome,
  skippedKeyLines,
  wantsRestore,
} from '../packages/cli/src/lib/cache';

describe('cache flag parsing', () => {
  test('no cache flags means an ordinary uncached instance', () => {
    expect(parseCacheConfig({})).toBeUndefined();
    expect(parseCacheConfig({ 'cache-key': '  ' })).toBeUndefined();
  });

  test('lists are split, trimmed and stripped of empties', () => {
    expect(
      parseCacheConfig({
        'cache-key': 'myapp-pr51',
        'cache-restore-keys': 'myapp-pr51, myapp-main ,,',
        'cache-paths': 'Pods,.build',
      }),
    ).toEqual({
      key: 'myapp-pr51',
      restoreKeys: ['myapp-pr51', 'myapp-main'],
      paths: ['Pods', '.build'],
    });
  });

  test('paths alone configure a cache without asking for a restore', () => {
    const config = parseCacheConfig({ 'cache-paths': 'Pods' });
    expect(config).toEqual({ paths: ['Pods'] });
    expect(wantsRestore(config)).toBe(false);
  });

  test('a key alone asks for a restore, since it doubles as the restore key', () => {
    expect(wantsRestore(parseCacheConfig({ 'cache-key': 'myapp-main' }))).toBe(true);
    expect(wantsRestore(parseCacheConfig({ 'cache-restore-keys': 'myapp-main' }))).toBe(true);
    expect(wantsRestore(undefined)).toBe(false);
  });
});

describe('restore rendering', () => {
  test('only the phases that are actually moving get a line', () => {
    expect(restoreProgressLine(cache({ restore: { phase: 'downloading' } }))).toMatch(/downloading/);
    expect(restoreProgressLine(cache({ restore: { phase: 'restored' } }))).toBeUndefined();
  });

  test('a hit reports where the bytes came from and how long they took', () => {
    const outcome = restoreOutcome(
      cache({
        restore: {
          phase: 'restored',
          matchedKey: 'myapp-main',
          matchKind: 'prefix_hit',
          bytes: 2 * 1024 * 1024 * 1024,
          source: 'tag',
          startedAt: '2026-07-30T10:00:00Z',
          finishedAt: '2026-07-30T10:00:41Z',
        },
      }),
      999_999,
    );
    expect(outcome.failed).toBe(false);
    expect(outcome.line).toBe(
      'Cache restored from myapp-main (prefix match), 2 GB via the regional accelerator in 41s.',
    );
  });

  test('a cold instance is not a failure and explains itself', () => {
    const cold = cache({ restore: { phase: 'skipped', reason: 'in_use' } });
    const outcome = restoreOutcome(cold, 1_000);
    expect(outcome.failed).toBe(false);
    expect(outcome.line).toMatch(/in use by another instance/);
    expect(outcome.line).toMatch(/cold workspace/);
  });

  test('an unsupported node is a fallback too', () => {
    const outcome = restoreOutcome(cache({ restore: { phase: 'disabled', reason: 'unsupported_node' } }), 0);
    expect(outcome.failed).toBe(false);
  });

  test('a broken restore is the one outcome a caller reacts to', () => {
    const outcome = restoreOutcome(
      cache({ restore: { phase: 'failed', reason: 'checksum', message: 'digest mismatch' } }),
      2_500,
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.line).toMatch(/checksum did not match: digest mismatch/);
  });

  test('the keys resolution passed over are listed with why', () => {
    const lines = skippedKeyLines(
      cache({
        restore: {
          phase: 'skipped',
          skippedKeys: [
            { key: 'myapp-pr51', reason: 'no_match' },
            { key: 'myapp-main', reason: 'scope_mismatch' },
          ],
        },
      }),
    );
    expect(lines).toEqual([
      '  myapp-pr51: no archive matched the restore keys',
      '  myapp-main: the archive stores a different set of paths',
    ]);
  });
});

describe('publication rendering', () => {
  test('a publication reports its key and size', () => {
    const outcome = saveOutcome(
      cache({
        restore: { phase: 'restored' },
        save: {
          phase: 'published',
          cacheKey: 'myapp-main',
          bytes: 1536,
          startedAt: '2026-07-30T10:00:00Z',
          finishedAt: '2026-07-30T10:01:04Z',
        },
      }),
      1,
    );
    expect(outcome.failed).toBe(false);
    expect(outcome.line).toBe('Cache published under myapp-main, 1.5 KB in 1m4s.');
  });

  test('a timeout leaves the previous archive alone and counts as a failure', () => {
    const outcome = saveOutcome(cache({ save: { phase: 'timed_out' } }), 600_000);
    expect(outcome.failed).toBe(true);
    expect(outcome.line).toMatch(/untouched/);
  });

  test('nothing to publish is a normal ending', () => {
    const outcome = saveOutcome(cache({ save: { phase: 'skipped', reason: 'no_successful_build' } }), 10);
    expect(outcome.failed).toBe(false);
    expect(outcome.line).toBe('Nothing published — no_successful_build.');
  });
});

test('bytes read as sizes a human recognizes', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(999)).toBe('999 B');
  expect(formatBytes(1024)).toBe('1 KB');
  expect(formatBytes(1024 * 1024 * 1024 * 3.25)).toBe('3.3 GB');
});

function cache(overrides: {
  restore?: Partial<XcodeInstanceCache['restore']>;
  save?: Partial<XcodeInstanceCache['save']>;
}): XcodeInstanceCache {
  return {
    restore: { phase: 'disabled', ...overrides.restore },
    save: { phase: 'disabled', ...overrides.save },
  };
}
