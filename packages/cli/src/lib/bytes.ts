export function formatBytes(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes}B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = '';
  for (const u of units) {
    value /= 1000;
    unit = u;
    if (value < 1000) break;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}${unit}`;
}

/** Bytes in 1024-based units, the way Xcode's memory gauge and the console count memory. */
export function formatBinaryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
