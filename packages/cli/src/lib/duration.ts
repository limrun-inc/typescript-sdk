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
