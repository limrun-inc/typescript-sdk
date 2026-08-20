// Helpers and platform-neutral types shared by the per-instance build-daemon
// clients (xcode, gradle).

import os from 'os';
import path from 'path';
import crypto from 'crypto';

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

/**
 * App metadata recorded on the asset at upload time, for bundles that don't
 * go through limbuild (which extracts and records it automatically). The
 * registry's OTA install flow reads the manifest identity from these fields.
 */
export type AssetUploadOptions = {
  /** Human-readable app title users see on iOS. */
  displayName?: string;
  /** CFBundleIdentifier of the uploaded app bundle. */
  bundleIdentifier?: string;
  /** CFBundleShortVersionString, e.g. 1.2.3. */
  shortVersion?: string;
  /** CFBundleVersion, e.g. 42. */
  buildVersion?: string;
  /** The app's primary URL scheme, e.g. "myapp" for myapp:// deep links. */
  deeplink?: string;
};

/**
 * Default TTL for build-product uploads. Every build upload without an
 * explicit ttl pushes the asset's expiry to 14 days from that upload, so
 * abandoned build artifacts don't accumulate in Asset Storage forever.
 * Assets uploaded through the general asset API keep no expiry by default.
 */
export const DEFAULT_BUILD_ASSET_TTL = '336h';

/**
 * Mints presigned upload/download URLs for a named asset via assets.getOrCreate,
 * wrapping failures with the asset name (and the original error as cause).
 * All build-product upload paths (xcodebuild, gradlebuild, RBE) go through
 * here, which is what scopes DEFAULT_BUILD_ASSET_TTL to build uploads.
 */
export function mintAssetUploadUrls(
  assets: {
    getOrCreate: (body: { name: string; ttl?: string } & AssetUploadOptions) => Promise<AssetUploadUrls>;
  },
  name: string,
  ttl?: string,
  uploadOptions?: AssetUploadOptions,
): Promise<AssetUploadUrls> {
  return assets.getOrCreate({ name, ttl: ttl || DEFAULT_BUILD_ASSET_TTL, ...uploadOptions }).catch((err) => {
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
