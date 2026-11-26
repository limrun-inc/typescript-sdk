import type Limrun from '@limrun/api';
import type { MacosClient, MacosSnapshotProgress } from '@limrun/api/resources/macos-instances-helpers';
import { macosSnapshotPermissions, restoreMacosSnapshot, waitMacosSnapshotSave } from './macos-snapshot';

describe('macosSnapshotPermissions', () => {
  it('reads the save key as a prefix and writes it, when it is also the restore key', () => {
    expect(macosSnapshotPermissions({ key: 'my-mac' })).toEqual([
      'asset:name/my-mac*:read',
      'asset:name/my-mac:create',
      'asset:name/my-mac:upload',
      'asset:name/my-mac:update',
    ]);
  });

  it('reads only the restore keys when they are given', () => {
    expect(macosSnapshotPermissions({ key: 'pr-51', restoreKeys: ['pr-51', 'main'] })).toEqual([
      'asset:name/pr-51*:read',
      'asset:name/main*:read',
      'asset:name/pr-51:create',
      'asset:name/pr-51:upload',
      'asset:name/pr-51:update',
    ]);
  });

  it('only reads when nothing is saved', () => {
    expect(macosSnapshotPermissions({ restoreKeys: ['main'] })).toEqual(['asset:name/main*:read']);
  });
});

describe('restoreMacosSnapshot', () => {
  function guest(events: MacosSnapshotProgress[]) {
    return {
      restoreSnapshot: jest.fn(
        async ({ onProgress }: { onProgress?: (p: MacosSnapshotProgress) => void }) => {
          for (const event of events) onProgress?.(event);
          return events[events.length - 1]!;
        },
      ),
    } as unknown as MacosClient;
  }

  it('reports each phase once and the download by tenths', async () => {
    const lines: string[] = [];
    const total = 1000;
    await restoreMacosSnapshot(
      guest([
        { phase: 'resolving' },
        { phase: 'downloading', key: 'my-mac', totalBytes: total, doneBytes: 0 },
        { phase: 'downloading', key: 'my-mac', totalBytes: total, doneBytes: 50 },
        { phase: 'downloading', key: 'my-mac', totalBytes: total, doneBytes: 500 },
        { phase: 'extracting' },
        { phase: 'extracting' },
        { phase: 'restored', key: 'my-mac' },
      ]),
      { key: 'my-mac' },
      (line) => lines.push(line),
    );
    expect(lines).toEqual([
      'Disk snapshot: resolving...',
      'Disk snapshot: downloading my-mac 0B of 1.0KB',
      'Disk snapshot: downloading my-mac 500B of 1.0KB',
      'Disk snapshot: extracting...',
      expect.stringMatching(/^Disk snapshot: restored my-mac in \d+s\.$/),
    ]);
  });

  it('keeps the disk of a guest that already restored, without progress lines', async () => {
    const lines: string[] = [];
    const result = await restoreMacosSnapshot(
      guest([{ phase: 'restored', key: 'my-mac', matchKind: 'exact_hit' }]),
      { key: 'my-mac' },
      (line) => lines.push(line),
    );
    expect(result.phase).toBe('restored');
    expect(lines).toEqual([
      'Disk snapshot: this instance already restored my-mac; its disk is kept as it is.',
    ]);
  });

  it('reports how an earlier restore ended', async () => {
    const lines: string[] = [];
    await restoreMacosSnapshot(guest([{ phase: 'failed', reason: 'checksum' }]), { key: 'my-mac' }, (line) =>
      lines.push(line),
    );
    expect(lines).toEqual([
      'Disk snapshot: this instance already ran its restore, which ended failed: the downloaded snapshot did not match its checksum. Nothing more is restored.',
    ]);
  });

  it('does not take a guest being deleted for an earlier restore', async () => {
    const lines: string[] = [];
    await restoreMacosSnapshot(
      guest([{ phase: 'skipped', reason: 'not_eligible', message: 'the instance is being deleted' }]),
      { key: 'my-mac' },
      (line) => lines.push(line),
    );
    expect(lines).toEqual([
      'Disk snapshot: nothing restored: the instance is being deleted. The instance starts without it.',
    ]);
  });

  it('explains why nothing was restored', async () => {
    const lines: string[] = [];
    const result = await restoreMacosSnapshot(
      guest([{ phase: 'resolving' }, { phase: 'skipped', reason: 'no_match' }]),
      { restoreKeys: ['main'] },
      (line) => lines.push(line),
    );
    expect(result.phase).toBe('skipped');
    expect(lines).toEqual([
      'Disk snapshot: resolving...',
      'Disk snapshot: nothing restored: no snapshot matches the restore keys. The instance starts without it.',
    ]);
  });
});

describe('waitMacosSnapshotSave', () => {
  function client(reads: Array<{ save?: { phase: string }; state?: string } | 404>) {
    const get = jest.fn(async () => {
      const next = reads.shift()!;
      if (next === 404) throw Object.assign(new Error('not found'), { status: 404 });
      return { status: { state: next.state ?? 'terminating', snapshot: next.save && { save: next.save } } };
    });
    return { macosInstances: { get } } as unknown as Limrun;
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function wait(c: Limrun): Promise<{ ok: boolean; lines: string[] }> {
    const lines: string[] = [];
    const waiting = waitMacosSnapshotSave(c, 'macos_test', (line) => lines.push(line));
    await jest.runAllTimersAsync();
    return { ok: await waiting, lines };
  }

  it('follows the save until it is published', async () => {
    const { ok, lines } = await wait(
      client([
        { save: { phase: 'archiving' } },
        { save: { phase: 'uploading' } },
        { save: { phase: 'published' } },
      ]),
    );
    expect(ok).toBe(true);
    expect(lines).toEqual([
      'Disk snapshot: archiving',
      'Disk snapshot: uploading',
      'Disk snapshot: published',
    ]);
  });

  it('reports a failed save', async () => {
    expect((await wait(client([{ save: { phase: 'failed' } }]))).ok).toBe(false);
  });

  it.each([[404 as const], [{ state: 'terminated' }]])(
    'treats an instance that is gone (%j) as a save that ended',
    async (gone) => {
      const { ok, lines } = await wait(client([{ save: { phase: 'uploading' } }, gone]));
      expect(ok).toBe(true);
      expect(lines).toEqual([
        'Disk snapshot: uploading',
        'The instance is gone; its save ended before its outcome could be read.',
      ]);
    },
  );
});
