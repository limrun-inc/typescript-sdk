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
