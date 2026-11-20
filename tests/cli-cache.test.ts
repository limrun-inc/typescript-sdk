import type { XcodeInstanceCache } from '@limrun/api';
import {
  formatBytes,
  gradleSnapshotConfig,
  parseCacheConfig,
  restoreOutcome,
  restoreProgressLine,
  saveOutcome,
  saveProgressLine,
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
      'Disk snapshot restored from myapp-main (prefix match), 2 GB via the regional accelerator in 41s.',
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

  test('a broken restore reports the failure and cold fallback', () => {
    const outcome = restoreOutcome(
      cache({ restore: { phase: 'failed', reason: 'checksum', message: 'digest mismatch' } }),
      2_500,
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.line).toMatch(/checksum did not match: digest mismatch/);
    expect(outcome.line).toContain('Continuing with a cold workspace.');
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
    expect(outcome.line).toBe('Disk snapshot published under myapp-main, 1.5 KB in 1m4s.');
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

describe('gradle snapshot rendering', () => {
  test('gradle phases get the same progress lines', () => {
    const state = (restore: string, save = 'idle') => ({
      restore: { phase: restore },
      save: { phase: save },
    });
    expect(restoreProgressLine(state('pending'))).toBe(
      'Disk snapshot restore: waiting for the build sandbox...',
    );
    expect(restoreProgressLine(state('extracting'))).toBe(
      'Disk snapshot restore: extracting the archive into the build sandbox...',
    );
    // Requested follows idle, so it says something new rather than repeating the idle line.
    expect(saveProgressLine(state('restored', 'requested'))).toBe(
      'Disk snapshot publish: asking the build sandbox to save...',
    );
  });

  test('a restore direct from object storage, and a key passed over for its toolchains', () => {
    const restored = restoreOutcome(
      {
        restore: {
          phase: 'restored',
          matchedKey: 'app/main',
          bytes: 2 * 1024 * 1024 * 1024,
          source: 'direct',
          startedAt: '2026-11-20T10:00:00Z',
          finishedAt: '2026-11-20T10:00:41Z',
        },
        save: { phase: 'idle' },
      },
      0,
    );
    expect(restored.line).toBe(
      'Disk snapshot restored from app/main, 2 GB direct from object storage in 41s.',
    );
    expect(
      skippedKeyLines({
        restore: { phase: 'skipped', skippedKeys: [{ key: 'app/pr-1', reason: 'compat_mismatch' }] },
        save: { phase: 'idle' },
      }),
    ).toEqual(['  app/pr-1: the snapshot was saved by a build sandbox with different toolchains']);
  });

  test("a save reports Gradle's key field, and a save with nothing built explains why", () => {
    expect(
      saveOutcome(
        { restore: { phase: 'disabled' }, save: { phase: 'published', key: 'app', bytes: 1024 } },
        5000,
      ).line,
    ).toBe('Disk snapshot published under app, 1 KB in 5s.');
    expect(
      saveOutcome({ restore: { phase: 'disabled' }, save: { phase: 'skipped', reason: 'not_eligible' } }, 0)
        .line,
    ).toBe('Nothing published — no build succeeded since the last sync.');
  });

  test('the Gradle create field carries no paths', () => {
    expect(gradleSnapshotConfig({ key: 'app', restoreKeys: ['app', 'main'] })).toEqual({
      key: 'app',
      restoreKeys: ['app', 'main'],
    });
    expect(gradleSnapshotConfig(undefined)).toBeUndefined();
  });
});
