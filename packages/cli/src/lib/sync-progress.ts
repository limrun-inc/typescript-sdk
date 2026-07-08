import type { SyncProgressEvent } from '@limrun/api';
import { ProgressReporter } from './progress';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Renders sync progress events onto a started ProgressReporter as one live
 * line. The caller owns start/stop; watch-mode background re-syncs keep
 * calling the callback, so it no-ops once the reporter has stopped (update
 * is a no-op without an active spinner).
 */
export function syncProgressRenderer(
  reporter: ProgressReporter,
  prefix: string,
): (e: SyncProgressEvent) => void {
  return (e) => {
    switch (e.phase) {
      case 'scan':
        reporter.update(
          `${prefix}: scanning ${e.files.toLocaleString()} files (${e.hashed.toLocaleString()} hashed)`,
        );
        break;
      case 'diff':
        reporter.update(
          `${prefix}: comparing ${e.checked.toLocaleString()}/${e.total.toLocaleString()} (${e.changed.toLocaleString()} changed)`,
        );
        break;
      case 'upload':
        reporter.update(`${prefix}: uploading ${formatBytes(e.sentBytes)} / ${formatBytes(e.totalBytes)}`);
        break;
    }
  };
}
