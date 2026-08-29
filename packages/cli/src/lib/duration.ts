/**
 * Parses a Go-style duration such as "72h", "90m", "1h30m", or "45s" into
 * whole seconds. Throws on anything else, including "1d" and bare numbers.
 */
export function parseDurationSeconds(value: string): number {
  const trimmed = value.trim();
  if (!/^(\d+(\.\d+)?(h|m|s))+$/.test(trimmed)) {
    throw new Error(`Invalid duration "${value}". Use hours, minutes, and seconds, e.g. 72h, 90m, 1h30m.`);
  }
  const unitSeconds: Record<string, number> = { h: 3600, m: 60, s: 1 };
  let seconds = 0;
  for (const [, amount, , unit] of trimmed.matchAll(/(\d+(\.\d+)?)(h|m|s)/g)) {
    seconds += Number(amount) * unitSeconds[unit!]!;
  }
  const rounded = Math.round(seconds);
  if (rounded <= 0) {
    throw new Error(`Invalid duration "${value}": must be longer than zero seconds.`);
  }
  return rounded;
}

function trimFraction(value: string): string {
  return value.replace(/\.?0+$/, '');
}

function formatSeconds(seconds: number): string {
  if (seconds >= 100) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds >= 10) {
    return `${trimFraction(seconds.toFixed(1))}s`;
  }
  return `${trimFraction(seconds.toFixed(3))}s`;
}

export function formatDurationMs(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));

  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60_000) {
    return formatSeconds(ms / 1000);
  }

  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = (ms % 60_000) / 1000;

  if (hours > 0) {
    const hourPart = `${hours}h`;
    const minutePart = minutes > 0 ? `${minutes}m` : '';
    const secondPart = seconds > 0 ? formatSeconds(seconds) : '';
    return `${hourPart}${minutePart}${secondPart}`;
  }

  const minutePart = `${minutes}m`;
  const secondPart = seconds > 0 ? formatSeconds(seconds) : '';
  return `${minutePart}${secondPart}`;
}
