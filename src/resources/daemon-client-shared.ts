// Helpers and platform-neutral types shared by the per-instance build-daemon
// clients (xcode, gradle).

import os from 'os';
import path from 'path';
import crypto from 'crypto';

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

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

export type AssetUploadUrls = { signedUploadUrl: string; signedDownloadUrl: string };

/**
 * Mints presigned upload/download URLs for a named asset via assets.getOrCreate,
 * wrapping failures with the asset name (and the original error as cause).
 */
export function mintAssetUploadUrls(
  assets: { getOrCreate: (body: { name: string; ttl?: string }) => Promise<AssetUploadUrls> },
  name: string,
  ttl?: string,
): Promise<AssetUploadUrls> {
  return assets.getOrCreate({ name, ...(ttl && { ttl }) }).catch((err) => {
    const message = `Failed to create upload URL for asset '${name}': ${
      err instanceof Error ? err.message : err
    }`;
    // @ts-ignore - not all envs have native support for cause yet
    throw new Error(message, { cause: err });
  });
}

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
