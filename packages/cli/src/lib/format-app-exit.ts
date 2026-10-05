/** The parts of an Android or iOS appExit notification this formatter prints. */
export type AppExitSummary = {
  reason: string;
  crash?: { processName: string; pid: number; shortMsg: string; longMsg?: string; stackTrace?: string };
  anr?: { processName: string; pid: number; processStats?: string };
};

/**
 * Renders an appExit notification as human-readable text: the exit reason, crash or ANR
 * details when present, and the recent app log tail delivered with the event.
 */
export function formatAppExit(appId: string, info: AppExitSummary, logs: string[]): string {
  const lines: string[] = [`${appId} exited (reason: ${info.reason})`];

  if (info.crash) {
    lines.push(`Crash in ${info.crash.processName} (pid ${info.crash.pid}): ${info.crash.shortMsg}`);
    if (info.crash.longMsg && info.crash.longMsg !== info.crash.shortMsg) {
      lines.push(info.crash.longMsg);
    }
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
