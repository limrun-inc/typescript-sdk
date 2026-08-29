import type { SessionArtifact } from '@limrun/api';

/**
 * Table rows for persisted session artifacts, shared by the recordings,
 * app-logs, and events list commands of both platforms. The download URL is
 * presigned and long, so the table keeps it out; --json carries it.
 */
export function sessionArtifactTable(artifacts: SessionArtifact[]): {
  headers: string[];
  rows: string[][];
} {
  const headers = ['ID', 'App', 'Started', 'Stopped', 'Size', 'Expires'];
  const rows = artifacts.map((a) => [
    a.id,
    a.bundleId ?? '',
    a.startedAt ?? '',
    a.stoppedAt ?? '',
    a.sizeBytes !== undefined ? formatSize(a.sizeBytes) : '',
    a.expiresAt ?? '',
  ]);
  return { headers, rows };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
