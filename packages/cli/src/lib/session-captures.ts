import type { PersistOption, SessionArtifact } from '@limrun/api';
import { formatBytes } from './bytes';

/**
 * The capture-start surface both platform clients share, so `ios create` and
 * `android create` can drive them with the same code.
 */
type CaptureClient = {
  startRecording: (options?: { persist?: PersistOption }) => Promise<void>;
  startAppLogCapture: (options: { bundleId: string; persist?: PersistOption }) => Promise<void>;
  startEventCapture: (options?: { persist?: PersistOption }) => Promise<void>;
};

export type CaptureRequest = {
  record: boolean;
  /** Bundle id (iOS) or package name (Android) to capture app logs for. */
  appLogsBundleId?: string;
  events: boolean;
  ttlSeconds: number;
};

/**
 * Starts the requested persisted captures and returns a human-readable
 * description of each one started, in start order. The captures keep running
 * server-side after the connection closes, until stopped or the instance
 * terminates.
 */
/**
 * Table headers and rows for a session-artifact listing. The Bundle ID
 * column appears only when at least one artifact carries one (app logs).
 */
export function sessionArtifactTable(artifacts: SessionArtifact[]): {
  headers: string[];
  rows: string[][];
} {
  const withBundle = artifacts.some((artifact) => artifact.bundleId);
  const headers = [
    'ID',
    ...(withBundle ? ['Bundle ID'] : []),
    'Started',
    'Stopped',
    'Expires',
    'Size',
    'Download URL',
  ];
  const rows = artifacts.map((artifact) => [
    artifact.id,
    ...(withBundle ? [artifact.bundleId ?? ''] : []),
    artifact.startedAt ?? '',
    artifact.stoppedAt ?? '',
    artifact.expiresAt ?? '',
    artifact.sizeBytes !== undefined ? formatBytes(artifact.sizeBytes) : '',
    artifact.downloadUrl,
  ]);
  return { headers, rows };
}

export async function startPersistedCaptures(
  client: CaptureClient,
  request: CaptureRequest,
): Promise<string[]> {
  const persist = { ttlSeconds: request.ttlSeconds };
  const started: string[] = [];
  if (request.record) {
    await client.startRecording({ persist });
    started.push('session recording');
  }
  if (request.appLogsBundleId) {
    await client.startAppLogCapture({ bundleId: request.appLogsBundleId, persist });
    started.push(`app log capture for ${request.appLogsBundleId}`);
  }
  if (request.events) {
    await client.startEventCapture({ persist });
    started.push('event log capture');
  }
  return started;
}
