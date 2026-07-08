import fs from 'fs';
import path from 'path';
import { META_CACHE_FILENAME } from './folder-sync-ignore';

/**
 * Sidecar metadata for the basis cache: known (mtimeMs, size) -> sha256
 * mappings for both the local tree and the basis copies, so unchanged files
 * are not re-hashed on every sync. mtimeMs is compared exactly as reported
 * by fs.stat; a copy that preserves mtime and size over changed content
 * (cp -p) is invisible to this cache — --fresh is the escape hatch.
 */
export type FileMetaEntry = { mtimeMs: number; size: number; sha256: string };

export type SyncMetaCache = {
  version: 1;
  /** Local tree entries, keyed by sync-relative path. */
  files: Record<string, FileMetaEntry>;
  /** Basis-copy entries (files under the basis cache dir), same keys. */
  basis: Record<string, FileMetaEntry>;
};

export function emptyMetaCache(): SyncMetaCache {
  return { version: 1, files: {}, basis: {} };
}

function metaCachePath(basisCacheDir: string): string {
  return path.join(basisCacheDir, META_CACHE_FILENAME);
}

/** Missing, corrupt, or wrong-version content falls back to an empty cache; never throws. */
export async function loadMetaCache(basisCacheDir: string): Promise<SyncMetaCache> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(metaCachePath(basisCacheDir), 'utf-8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.version === 1 &&
      typeof parsed.files === 'object' &&
      typeof parsed.basis === 'object'
    ) {
      return parsed as SyncMetaCache;
    }
  } catch {
    // fall through to empty
  }
  return emptyMetaCache();
}

/** Atomic (tmp + rename) so a crashed sync never leaves a half-written cache. */
export async function saveMetaCache(basisCacheDir: string, cache: SyncMetaCache): Promise<void> {
  const dst = metaCachePath(basisCacheDir);
  const tmp = `${dst}.tmp`;
  await fs.promises.mkdir(basisCacheDir, { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(cache));
  await fs.promises.rename(tmp, dst);
}
