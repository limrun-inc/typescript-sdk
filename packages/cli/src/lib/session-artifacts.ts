import type { SessionArtifact } from '@limrun/api';
import { formatBinaryBytes } from './bytes';

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
    a.sizeBytes !== undefined ? formatBinaryBytes(a.sizeBytes) : '',
    a.expiresAt ?? '',
  ]);
  return { headers, rows };
}
