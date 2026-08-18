import type { AppExitInfo } from '@limrun/api';

/**
 * Renders an Android appExit notification as human-readable text: the exit
 * reason, crash or ANR details when present, and the recent app log tail
 * delivered with the event.
 */
export function formatAppExit(info: AppExitInfo, logs: string[]): string {
  const lines: string[] = [`${info.packageName} exited (reason: ${info.reason})`];

  if (info.crash) {
    lines.push(`Crash in ${info.crash.processName} (pid ${info.crash.pid}): ${info.crash.shortMsg}`);
    if (info.crash.stackTrace) {
      lines.push(info.crash.stackTrace.trimEnd());
    }
  }

  if (info.anr) {
    lines.push(`ANR in ${info.anr.processName} (pid ${info.anr.pid})`);
    if (info.anr.processStats) {
      lines.push(info.anr.processStats.trimEnd());
    }
  }

  if (logs.length > 0) {
    lines.push(`--- Recent app logs (${logs.length} lines) ---`);
    lines.push(...logs);
  }

  return lines.join('\n');
}
