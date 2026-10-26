// Helpers and platform-neutral types shared by the per-instance build-daemon
// clients (xcode, gradle).

import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { exec, type ExecOptions, type RunExecRequest } from '../exec-client';

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

// BuildLog is one persisted build record from the director's per-platform
// GET /v1/{platform}_instances/{id}/build_logs endpoints. The xcode and
// gradle responses share this exact shape (their OpenAPI schemas are
// structurally identical), so it is defined once here and aliased per
// resource; a platform gaining a field of its own is the signal to split the
// aliases back into real interfaces. Hand-written against
// api/public/director/openapiv3.yaml; if a Stainless regeneration ever picks
// those paths up, reconcile with the generated surface instead of
// duplicating it.
export interface BuildLog {
  /** Exec ID assigned by the build daemon, e.g. build-1776140344112378000. */
  id: string;

  /** Terminal status reported by the build daemon (e.g. SUCCEEDED, FAILED, CANCELLED). */
  status: string;

  /** Exit code of the build tool invocation, if the build reached completion. */
  exitCode?: number;

  startedAt?: string;

  finishedAt?: string;

  /** Time spent running the build tool, in milliseconds. */
  buildDurationMs?: number;

  /** Error message captured by the build daemon on failure, if any. */
  error?: string;

  /** Short-lived presigned URL for fetching the plain-text build log from object storage. */
  downloadUrl: string;
}

/**
 * Derives the client-side folder-sync cache location for a local project.
 * The key format is a compatibility contract: changing it orphans every
 * user's existing basis cache, so both daemon clients must share this one
 * derivation.
 */
export function deriveBasisCache(
  localCodePath: string,
  override?: string,
): { cacheKey: string; basisCacheDir: string } {
  const resolvedPath = path.resolve(localCodePath);
  const folderName = path.basename(resolvedPath);
  const hash = crypto.createHash('sha1').update(resolvedPath).digest('hex').slice(0, 8);
  const cacheKey = `limsync-cache-${folderName}-${hash}`;
  return { cacheKey, basisCacheDir: override ?? path.join(os.tmpdir(), cacheKey) };
}

export type SyncResult = {
  /**
   * Number of bytes transmitted to the server for this sync (full uploads plus
   * delta patches, before transport compression). In watch mode, this reflects
   * the initial sync only.
   */
  bytesSent?: number;
  /** Present only when watch=true; call to stop watching */
  stopWatching?: () => Promise<void>;
};

export type AssetUploadUrls = { id: string; signedUploadUrl: string; signedDownloadUrl: string };

// Compatibility exports for callers that imported build-upload metadata here.
export type { AssetUploadMetadata as AssetUploadOptions } from '../lib/asset-permissions';
export { DEFAULT_BUILD_ASSET_TTL } from '../lib/asset-permissions';

const logLevels: LogLevel[] = ['none', 'error', 'warn', 'info', 'debug'];

export function createDaemonLogger(prefix: string, logLevel: LogLevel) {
  const threshold = logLevels.indexOf(logLevel);
  const shouldLog = (level: LogLevel) => threshold >= logLevels.indexOf(level);
  return (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => {
    if (!shouldLog(level)) return;
    if (level === 'error' || level === 'warn') {
      console[level](prefix, msg);
    } else {
      console.log(prefix, msg);
    }
  };
}

export type BuildRunOptions = {
  /** Working directory relative to the synced workspace. Defaults to ".". */
  cwd?: string;
  /** Extra KEY=VALUE entries. Sandbox paths remain managed; the last repeated user entry wins. */
  env?: string[];
  /** Command timeout in seconds, from 1 to 21600. Defaults to 3600. */
  timeoutSeconds?: number;
};

/** Create the shared shell command runner for build sandboxes. */
export function createBuildRun(execOptions: ExecOptions) {
  return (commandLine: string, options?: BuildRunOptions) => {
    if (commandLine.trim() === '') throw new Error('commandLine must not be empty');
    if (
      options?.timeoutSeconds !== undefined &&
      (!Number.isInteger(options.timeoutSeconds) ||
        options.timeoutSeconds < 1 ||
        options.timeoutSeconds > 21600)
    ) {
      throw new Error('timeoutSeconds must be an integer between 1 and 21600');
    }
    const request: RunExecRequest = {
      command: 'run',
      commandLine,
      cwd: options?.cwd ?? '.',
      ...(options?.env?.length && { env: options.env }),
      ...(options?.timeoutSeconds !== undefined && { timeoutSeconds: options.timeoutSeconds }),
    };
    return exec(request, execOptions);
  };
}
