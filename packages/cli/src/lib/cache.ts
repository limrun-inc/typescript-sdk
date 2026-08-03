import type {
  XcodeCacheConfig,
  XcodeCacheRestoreStatus,
  XcodeCacheSaveStatus,
  XcodeInstanceCache,
} from '@limrun/api';
import { formatDurationMs } from './duration';

// The oclif flag definitions live in ./cache-flags so that everything here stays importable
// without oclif, which is what lets the root test suite cover it.

export type CacheFlags = {
  'cache-key'?: string | undefined;
  'cache-restore-keys'?: string | undefined;
  'cache-paths'?: string | undefined;
};

/** The cache configuration a create request carries, or undefined for an ordinary instance. */
export function parseCacheConfig(flags: CacheFlags): XcodeCacheConfig | undefined {
  const key = flags['cache-key']?.trim() || undefined;
  const restoreKeys = splitList(flags['cache-restore-keys']);
  const paths = splitList(flags['cache-paths']);
  if (!key && !restoreKeys && !paths) {
    return undefined;
  }
  return {
    ...(key ? { key } : {}),
    ...(restoreKeys ? { restoreKeys } : {}),
    ...(paths ? { paths } : {}),
  };
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Whether a config asks for a restore at all, which is what makes create block. */
export function wantsRestore(config: XcodeCacheConfig | undefined): boolean {
  return !!config && ((config.restoreKeys?.length ?? 0) > 0 || !!config.key);
}

const RESTORE_PROGRESS: Record<string, string> = {
  placing: 'preparing the workspace directory',
  downloading: 'downloading the archive',
  materializing: 'unpacking the archive into the workspace',
};

const SAVE_PROGRESS: Record<string, string> = {
  idle: 'waiting for the build sandbox to stop',
  quiescing: 'stopping the build sandbox',
  archiving: 'archiving the workspace',
  uploading: 'uploading the archive',
  verifying: 'verifying the upload',
};

const REASONS: Record<string, string> = {
  no_match: 'no archive matched the restore keys',
  in_use: 'the stable workspace directory is in use by another instance',
  link_conflict: 'the stable workspace directory conflicts with an existing one',
  unsupported_node: 'the node this instance landed on has no cache storage configured',
  checksum: 'the archive checksum did not match',
  directory_key_mismatch: 'the archive belongs to a different workspace directory',
  root_name_mismatch: 'the archive was built under a different project root name',
  scope_mismatch: 'the archive stores a different set of paths',
  xcode_version_mismatch: 'the archive was built with a different Xcode',
  disk_headroom: 'the node does not have enough free disk space',
  transport: 'the transfer failed',
  publish_deadline: 'publication ran past the time limit',
  no_pod: 'the instance had no node left to publish from',
};

function explain(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return REASONS[reason] ?? reason;
}

/** A line for a phase that is still moving, or undefined for phases with nothing to say. */
export function restoreProgressLine(cache: XcodeInstanceCache): string | undefined {
  const text = RESTORE_PROGRESS[cache.restore.phase];
  return text ? `Cache restore: ${text}...` : undefined;
}

export function saveProgressLine(cache: XcodeInstanceCache): string | undefined {
  const text = SAVE_PROGRESS[cache.save.phase];
  return text ? `Cache publish: ${text}...` : undefined;
}

/**
 * How the restore ended, in one line, plus whether it is the kind of ending a caller reacts to.
 * A cold instance is a normal outcome; only `failed` means the warm workspace that was asked
 * for is not there and something is actually wrong.
 */
export function restoreOutcome(
  cache: XcodeInstanceCache,
  fallbackMs: number,
): { line: string; failed: boolean } {
  const restore = cache.restore;
  const took = ` in ${formatDurationMs(durationMs(restore, fallbackMs))}`;
  switch (restore.phase) {
    case 'restored': {
      const from = restore.matchedKey ? ` from ${restore.matchedKey}` : '';
      const kind = restore.matchKind === 'prefix_hit' ? ' (prefix match)' : '';
      const size = restore.bytes ? `, ${formatBytes(restore.bytes)}` : '';
      const via =
        restore.source === 'tag' ? ' via the regional accelerator'
        : restore.source === 'tigris' ? ' direct from object storage'
        : '';
      return { line: `Cache restored${from}${kind}${size}${via}${took}.`, failed: false };
    }
    case 'failed': {
      const why = explain(restore.reason);
      const detail = restore.message ? `: ${restore.message}` : '';
      return {
        line: `Cache restore failed${why ? ` — ${why}` : ''}${detail}${took}.`,
        failed: true,
      };
    }
    default: {
      const why = explain(restore.reason);
      return {
        line: `No cache restored${why ? ` — ${why}` : ''}. Continuing with a cold workspace.`,
        failed: false,
      };
    }
  }
}

/** The keys resolution passed over, as indented lines, so a miss is explainable. */
export function skippedKeyLines(cache: XcodeInstanceCache): string[] {
  return (cache.restore.skippedKeys ?? []).map(
    (skipped) => `  ${skipped.key}: ${explain(skipped.reason) ?? skipped.reason}`,
  );
}

export function saveOutcome(
  cache: XcodeInstanceCache,
  fallbackMs: number,
): { line: string; failed: boolean } {
  const save = cache.save;
  const took = ` in ${formatDurationMs(durationMs(save, fallbackMs))}`;
  const why = explain(save.reason);
  switch (save.phase) {
    case 'published': {
      const under = save.cacheKey ? ` under ${save.cacheKey}` : '';
      const size = save.bytes ? `, ${formatBytes(save.bytes)}` : '';
      return { line: `Cache published${under}${size}${took}.`, failed: false };
    }
    case 'failed':
      return {
        line: `Cache publish failed${why ? ` — ${why}` : ''}${
          save.message ? `: ${save.message}` : ''
        }${took}.`,
        failed: true,
      };
    case 'timed_out':
      return { line: `Cache publish timed out${took}. The previous archive is untouched.`, failed: true };
    default:
      return { line: `Nothing published${why ? ` — ${why}` : ''}.`, failed: false };
  }
}

/**
 * Server-measured duration when the status carries both ends, since that is the time the
 * transfer actually took rather than the time this process spent watching it.
 */
function durationMs(status: XcodeCacheRestoreStatus | XcodeCacheSaveStatus, fallbackMs: number): number {
  if (status.startedAt && status.finishedAt) {
    const started = Date.parse(status.startedAt);
    const finished = Date.parse(status.finishedAt);
    if (!Number.isNaN(started) && !Number.isNaN(finished) && finished >= started) {
      return finished - started;
    }
  }
  return fallbackMs;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}
