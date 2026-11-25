import type Limrun from '@limrun/api';
import type { MacosClient, MacosSnapshotProgress } from '@limrun/api/resources/macos-instances-helpers';
import { formatBytes } from './bytes';

/** What a macOS snapshot needs from the create flags: where it saves, and what it restores. */
export interface MacosSnapshotFlags {
  key?: string;
  restoreKeys?: string[];
}

/**
 * The role permissions a macOS snapshot needs. A snapshot is an asset, so the instance reads the
 * names it restores, each as a prefix since a restore falls back to the newest name starting with
 * the key, and creates, uploads and updates the name it saves under.
 */
export function macosSnapshotPermissions({ key, restoreKeys }: MacosSnapshotFlags): string[] {
  const reads = restoreKeys ?? (key ? [key] : []);
  return [
    ...reads.map((name) => `asset:name/${name}*:read`),
    ...(key ? ['create', 'upload', 'update'].map((verb) => `asset:name/${key}:${verb}`) : []),
  ];
}

const RESTORE_REASONS: Record<string, string> = {
  no_match: 'no snapshot matches the restore keys',
  compat_mismatch: 'the snapshot was saved on another macOS build',
  checksum: 'the downloaded snapshot did not match its checksum',
  disk_headroom: 'the instance does not have enough free disk space',
  transport: 'the transfer failed',
  extract: 'extracting the snapshot failed',
};

/** restoreMacosSnapshot restores and reports progress, a line per phase and per download tenth. */
export async function restoreMacosSnapshot(
  guest: MacosClient,
  flags: MacosSnapshotFlags,
  info: (line: string) => void,
): Promise<MacosSnapshotProgress> {
  const started = Date.now();
  let lastPhase = '';
  let lastTenth = -1;
  const result = await guest.restoreSnapshot({
    ...(flags.key && { key: flags.key }),
    ...(flags.restoreKeys && { restoreKeys: flags.restoreKeys }),
    onProgress: (progress) => {
      if (progress.phase === 'downloading' && progress.totalBytes) {
        const tenth = Math.floor(((progress.doneBytes ?? 0) / progress.totalBytes) * 10);
        if (tenth === lastTenth) return;
        lastTenth = tenth;
        info(
          `Disk snapshot: downloading ${progress.key ?? ''} ${formatBytes(
            progress.doneBytes ?? 0,
          )} of ${formatBytes(progress.totalBytes)}`.replace('  ', ' '),
        );
      } else if (
        progress.phase !== lastPhase &&
        progress.phase !== 'restored' &&
        progress.phase !== 'skipped'
      ) {
        info(`Disk snapshot: ${progress.phase}...`);
      }
      lastPhase = progress.phase;
    },
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.phase === 'restored') {
    info(`Disk snapshot: restored ${result.key ?? ''} in ${seconds}s.`.replace('  ', ' '));
  } else {
    const why = (result.reason && RESTORE_REASONS[result.reason]) ?? result.message ?? result.reason;
    info(
      `Disk snapshot: ${result.phase === 'skipped' ? 'nothing restored' : 'restore failed'}${
        why ? `: ${why}` : ''
      }. The instance starts without it.`,
    );
  }
  return result;
}

const SAVE_TERMINAL = new Set(['published', 'skipped', 'failed', 'timed_out']);

/**
 * waitMacosSnapshotSave follows the save a deleted instance runs, by reading the instance until the
 * save ends or the instance is gone. Returns whether nothing was lost: published, skipped, or gone.
 *
 * The save's phase is readable only while the instance is held for it. A terminated instance reads
 * from its record, which has no save, a few seconds after the save ends, so it is read every second
 * to see the last phase first.
 */
export async function waitMacosSnapshotSave(
  client: Limrun,
  id: string,
  info: (line: string) => void,
  timeoutMs = 12 * 60 * 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  const gone = () => {
    if (!SAVE_TERMINAL.has(last))
      info('The instance is gone; its save ended before its outcome could be read.');
    return last !== 'failed' && last !== 'timed_out';
  };
  while (Date.now() < deadline) {
    let save: { phase: string; reason?: string; message?: string } | undefined;
    try {
      const instance = await client.macosInstances.get(id);
      save = instance.status.snapshot?.save;
      if (!save && instance.status.state === 'terminated') return gone();
    } catch (err) {
      if ((err as { status?: number }).status === 404) return gone();
      throw err;
    }
    if (save && save.phase !== last) {
      last = save.phase;
      info(`Disk snapshot: ${save.phase}${save.message ? `: ${save.message}` : ''}`);
    }
    if (save && SAVE_TERMINAL.has(save.phase)) return save.phase === 'published' || save.phase === 'skipped';
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  info('Timed out waiting for the disk snapshot save; it may still finish.');
  return false;
}
