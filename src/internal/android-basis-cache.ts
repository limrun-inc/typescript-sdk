import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { downloadFileToLocalPath } from './download-file';
import { nodeProxyTransport } from './proxy-transport';

export type AndroidSyncState = {
  roots?: Array<{
    rootName?: string;
    files?: Array<{ path?: string; sha256?: string; size?: number; mode?: number }>;
  }>;
  seeds?: Array<{ sha256?: string; size?: number; name?: string; mtime?: number }>;
};

type SyncLog = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

function buildSyncStateUrl(apiUrl: string): string {
  return `${apiUrl}/sync/state`;
}

function buildSyncSeedUrl(apiUrl: string, sha256: string): string {
  return `${apiUrl}/sync/seeds/${encodeURIComponent(sha256)}`;
}

async function sha256FileHex(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fetchAndroidSyncState(apiUrl: string, token: string): Promise<AndroidSyncState> {
  const response = await nodeProxyTransport.fetch(buildSyncStateUrl(apiUrl), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch Android sync state: ${response.status} ${text}`);
  }
  return (await response.json()) as AndroidSyncState;
}

/**
 * Make the local basis cache usable for a delta sync against this specific
 * instance. The daemon only applies a delta when it holds the exact basis
 * sha256 the client encoded against (its synced file or a retained seed), so
 * an existing local basis is verified against the instance's `/sync/state`
 * and replaced (or dropped) when the instance doesn't know it — otherwise a
 * warm cache pointed at a fresh instance sends a doomed delta, gets needFull
 * back, and silently re-uploads the entire APK.
 */
export async function bootstrapAndroidBasisCache(
  apkPath: string,
  basisCacheDir: string,
  apiUrl: string,
  token: string,
  log: SyncLog,
  onBasisDownloadProgress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  const remotePath = path.basename(apkPath);
  const basisPath = path.join(basisCacheDir, remotePath);
  const state = await fetchAndroidSyncState(apiUrl, token).catch((err) => {
    log('debug', `android sync state unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  if (!state) {
    // Without state we cannot verify anything; keep whatever local basis exists.
    return;
  }

  // Every sha the daemon can resolve as a delta basis: the currently synced
  // file at this path plus retained seeds (the daemon's findBasis checks both).
  const serverShas = new Set<string>();
  for (const root of state.roots ?? []) {
    for (const file of root.files ?? []) {
      if (file.path === remotePath && typeof file.sha256 === 'string') {
        serverShas.add(file.sha256.toLowerCase());
      }
    }
  }
  const seeds = [...(state.seeds ?? [])]
    .filter(
      (seed): seed is { sha256: string; size?: number; name?: string; mtime?: number } =>
        typeof seed.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(seed.sha256),
    )
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  for (const seed of seeds) {
    serverShas.add(seed.sha256.toLowerCase());
  }

  if (fs.existsSync(basisPath)) {
    const basisSha = (await sha256FileHex(basisPath)).toLowerCase();
    if (serverShas.has(basisSha)) {
      return;
    }
    // A delta against a basis this instance doesn't have only earns a needFull
    // round trip and then a full upload (e.g. a warm cache pointed at a fresh
    // instance), so drop the stale basis and re-seed below.
    log('debug', `local basis ${basisSha} unknown to instance; re-seeding basis cache`);
    await fs.promises.rm(basisPath, { force: true });
  }

  const localSha = (await sha256FileHex(apkPath)).toLowerCase();
  if (serverShas.has(localSha)) {
    // The instance already has these exact bytes; the local APK doubles as the
    // basis without any transfer.
    await fs.promises.mkdir(path.dirname(basisPath), { recursive: true });
    await fs.promises.copyFile(apkPath, basisPath);
    log('debug', `seeded Android basis cache from local APK already known to instance: ${localSha}`);
    return;
  }
  const seed = seeds[0];
  if (!seed) {
    return;
  }
  // Announce the download before any bytes flow so consumers can react to the
  // expected size even during connection setup / time-to-first-byte.
  onBasisDownloadProgress?.(0, seed.size ?? 0);
  await downloadFileToLocalPath(
    buildSyncSeedUrl(apiUrl, seed.sha256),
    token,
    basisPath,
    onBasisDownloadProgress,
  );
  log('debug', `seeded Android basis cache from instance seed: ${seed.sha256}`);
}
