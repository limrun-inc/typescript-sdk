// Helpers and platform-neutral types shared by the per-instance build-daemon
// clients (xcode, gradle).

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

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

export function createDaemonLogger(prefix: string, logLevel: LogLevel) {
  const shouldLog = (level: LogLevel) => {
    const levels: LogLevel[] = ['none', 'error', 'warn', 'info', 'debug'];
    return levels.indexOf(logLevel) >= levels.indexOf(level);
  };
  return (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => {
    if (!shouldLog(level)) return;
    if (level === 'error' || level === 'warn') {
      console[level](prefix, msg);
    } else {
      console.log(prefix, msg);
    }
  };
}
