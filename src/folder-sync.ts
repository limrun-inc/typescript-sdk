import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { watchFolderTree } from './folder-sync-watcher';
import { Readable } from 'stream';

// =============================================================================
// Folder Sync (HTTP batch)
// =============================================================================

export type FolderSyncOptions = {
  apiUrl: string;
  token: string;
  udid: string; // used only for local cache scoping
  install?: boolean;
  launchMode?: 'ForegroundIfRunning' | 'RelaunchIfRunning' | 'FailIfRunning';
  /** If true, watch the folder and re-sync on any changes (debounced, single-flight). */
  watch?: boolean;
  /** Max patch size (bytes) to send as delta before falling back to full upload. */
  maxPatchBytes?: number;
  /** Controls logging verbosity */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
};

export type SyncFolderResult = {
  installedAppPath?: string;
  installedBundleId?: string;
  /** Present only when watch=true; call to stop watching. */
  stopWatching?: () => void;
};

type FileEntry = { path: string; size: number; sha256: string; absPath: string; mode: number };

type FolderSyncHttpPayload = {
  kind: 'delta' | 'full';
  path: string;
  /** Required for delta. Must match server's current sha for this path. */
  basisSha256?: string;
  /** Expected target sha after apply (also must match manifest's sha for path). */
  targetSha256: string;
  /** Number of bytes that will follow for this payload in the request body. */
  length: number;
};
type FolderSyncHttpMeta = {
  id: string;
  rootName: string;
  install?: boolean;
  launchMode?: 'ForegroundIfRunning' | 'RelaunchIfRunning' | 'FailIfRunning';
  files: { path: string; size: number; sha256: string; mode: number }[];
  payloads: FolderSyncHttpPayload[];
};
type FolderSyncHttpResponse = {
  ok: boolean;
  needFull?: string[];
  installedAppPath?: string;
  bundleId?: string;
  error?: string;
};

const noopLogger = (_level: 'debug' | 'info' | 'warn' | 'error', _msg: string) => {
  // Intentionally empty: callers (e.g. ios-client.ts) should provide their own logger
  // to control verbosity and integrate with the SDK's logging setup.
};

function nowMs(): number {
  return Date.now();
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)}KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)}MiB`;
  const gib = mib / 1024;
  return `${gib.toFixed(2)}GiB`;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function concurrencyLimit(): number {
  // min(4, max(1, cpuCount-1))
  const cpu = os.cpus()?.length ?? 1;
  return Math.min(4, Math.max(1, cpu - 1));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const my = idx++;
      if (my >= items.length) return;
      const item = items[my]!;
      results[my] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function folderSyncHttpUrl(apiUrl: string): string {
  return `${apiUrl}/folder-sync`;
}

function u32be(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

async function httpFolderSyncBatch(
  opts: FolderSyncOptions,
  meta: FolderSyncHttpMeta,
  payloadFiles: { filePath: string }[],
): Promise<FolderSyncHttpResponse> {
  const url = folderSyncHttpUrl(opts.apiUrl);
  const headers: Record<string, string> = {
    // OpenAPI route expects application/octet-stream.
    'Content-Type': 'application/octet-stream',
    Authorization: `Bearer ${opts.token}`,
  };

  const metaBytes = Buffer.from(JSON.stringify(meta), 'utf-8');
  const head = Buffer.concat([u32be(metaBytes.length), metaBytes]);

  async function* gen(): AsyncGenerator<Buffer> {
    yield head;
    for (const p of payloadFiles) {
      const fd = await fs.promises.open(p.filePath, 'r');
      try {
        const st = await fd.stat();
        let offset = 0;
        while (offset < st.size) {
          const len = Math.min(256 * 1024, st.size - offset);
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fd.read(buf, 0, len, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
          yield buf.subarray(0, bytesRead);
        }
      } finally {
        await fd.close();
      }
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: Readable.from(gen()) as any,
    duplex: 'half' as any,
  } as any);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`folder-sync http failed: ${res.status} ${text}`);
  }
  return JSON.parse(text) as FolderSyncHttpResponse;
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

async function walkFiles(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const stack: string[] = [root];
  const rootResolved = path.resolve(root);
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === '.DS_Store') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const st = await fs.promises.stat(abs);
      const rel = path.relative(rootResolved, abs).split(path.sep).join('/');
      const sha256 = await sha256FileHex(abs);
      // Preserve POSIX permission bits (including +x). Mask out file-type bits.
      const mode = st.mode & 0o7777;
      out.push({ path: rel, size: st.size, sha256, absPath: abs, mode });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

let xdelta3Ready: Promise<void> | null = null;
async function ensureXdelta3(): Promise<void> {
  if (!xdelta3Ready) {
    xdelta3Ready = new Promise<void>((resolve, reject) => {
      const p = spawn('xdelta3', ['-V']);
      p.on('error', reject);
      p.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`xdelta3 not available (exit=${code})`));
      });
    });
  }
  return await xdelta3Ready;
}

async function runXdelta3Encode(basis: string, target: string, outPatch: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('xdelta3', ['-e', '-s', basis, target, outPatch], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`xdelta3 encode failed (exit=${code}): ${stderr.trim()}`));
    });
  });
}

function localBasisCacheRoot(opts: FolderSyncOptions): string {
  const hostKey = opts.apiUrl.replace(/[:/]+/g, '_');
  // Include a stable suffix to avoid collisions if different folder basenames are synced for the same UDID.
  return path.join(os.homedir(), '.cache', 'limulator', 'folder-sync', hostKey, opts.udid);
}

async function cachePut(cacheRoot: string, relPath: string, srcFile: string): Promise<void> {
  const dst = path.join(cacheRoot, relPath.split('/').join(path.sep));
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.copyFile(srcFile, dst);
}

function cacheGet(cacheRoot: string, relPath: string): string {
  return path.join(cacheRoot, relPath.split('/').join(path.sep));
}

export type SyncAppResult = SyncFolderResult;

export async function syncApp(localFolderPath: string, opts: FolderSyncOptions): Promise<SyncFolderResult> {
  if (!opts.watch) {
    return await syncFolderOnce(localFolderPath, opts);
  }
  // Initial sync, then watch for changes and re-run sync in the background.
  const first = await syncFolderOnce(localFolderPath, opts, 'startup');
  let inFlight = false;
  let queued = false;

  const run = async (reason: string) => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      await syncFolderOnce(localFolderPath, opts, reason);
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void run('queued-changes');
      }
    }
  };

  const watcherLog = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => {
    (opts.log ?? noopLogger)(level, `syncApp: ${msg}`);
  };
  const watcher = await watchFolderTree({
    rootPath: localFolderPath,
    log: watcherLog,
    onChange: (reason) => {
      void run(reason);
    },
  });

  return {
    ...first,
    stopWatching: () => {
      watcher.close();
    },
  };
}

// Back-compat alias (older callers)
export async function syncFolder(
  localFolderPath: string,
  opts: FolderSyncOptions,
): Promise<SyncFolderResult> {
  return await syncApp(localFolderPath, opts);
}

async function syncFolderOnce(
  localFolderPath: string,
  opts: FolderSyncOptions,
  reason?: string,
): Promise<SyncFolderResult> {
  const totalStart = nowMs();
  const log = opts.log ?? noopLogger;
  const slog = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => log(level, `syncApp: ${msg}`);
  const maxPatchBytes = opts.maxPatchBytes ?? 4 * 1024 * 1024;

  const tEnsureStart = nowMs();
  await ensureXdelta3();
  const tEnsureMs = nowMs() - tEnsureStart;

  const tWalkStart = nowMs();
  const files = await walkFiles(localFolderPath);
  const tWalkMs = nowMs() - tWalkStart;
  const fileMap = new Map(files.map((f) => [f.path, f]));
  slog('info', `sync started files=${files.length}${reason ? ` reason=${reason}` : ''}`);

  const syncId = genId('sync');
  const rootName = path.basename(path.resolve(localFolderPath));

  const cacheRoot = localBasisCacheRoot(opts);
  await fs.promises.mkdir(cacheRoot, { recursive: true });

  // Track how many bytes we actually transmit to the server (single HTTP request).
  let bytesSentFull = 0;
  let bytesSentDelta = 0;
  let httpSendMsTotal = 0;
  let deltaEncodeMsTotal = 0;
  type EncodedPayload = { payload: FolderSyncHttpPayload; filePath: string; cleanupDir?: string };

  // Build payload list by comparing against local basis cache (single-flight/watch assumes server matches cache).
  const encodeLimit = concurrencyLimit();
  const changed: FileEntry[] = [];
  for (const f of files) {
    const basisPath = cacheGet(cacheRoot, f.path);
    if (!fs.existsSync(basisPath)) {
      changed.push(f);
      continue;
    }
    const basisSha = await sha256FileHex(basisPath);
    if (basisSha !== f.sha256.toLowerCase()) {
      changed.push(f);
    }
  }

  const encodedPayloads = await mapLimit(changed, encodeLimit, async (f): Promise<EncodedPayload> => {
    const basisPath = cacheGet(cacheRoot, f.path);
    if (fs.existsSync(basisPath)) {
      const basisSha = await sha256FileHex(basisPath);
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'limulator-xdelta3-'));
      const patchPath = path.join(tmpDir, 'patch.xdelta3');
      const encodeStart = nowMs();
      await runXdelta3Encode(basisPath, f.absPath, patchPath);
      const encodeMs = nowMs() - encodeStart;
      deltaEncodeMsTotal += encodeMs;
      const st = await fs.promises.stat(patchPath);
      if (st.size <= maxPatchBytes) {
        slog(
          'debug',
          `delta(file): ${path.posix.basename(f.path)} patchSize=${st.size} encode=${fmtMs(encodeMs)}`,
        );
        bytesSentDelta += st.size;
        return {
          payload: {
            kind: 'delta',
            path: f.path,
            basisSha256: basisSha.toLowerCase(),
            targetSha256: f.sha256.toLowerCase(),
            length: st.size,
          },
          filePath: patchPath,
          cleanupDir: tmpDir,
        };
      }
      // Patch too big, fall back to full
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    slog('debug', `full(file): ${f.path} size=${f.size}`);
    bytesSentFull += f.size;
    return {
      payload: { kind: 'full', path: f.path, targetSha256: f.sha256.toLowerCase(), length: f.size },
      filePath: f.absPath,
    };
  });

  const meta: FolderSyncHttpMeta = {
    id: syncId,
    rootName,
    install: opts.install ?? true,
    ...(opts.launchMode ? { launchMode: opts.launchMode } : {}),
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256.toLowerCase(), mode: f.mode })),
    payloads: encodedPayloads.map((p) => p.payload),
  };

  const sendStart = nowMs();
  let resp = await httpFolderSyncBatch(
    opts,
    meta,
    encodedPayloads.map((p) => ({ filePath: p.filePath })),
  );
  httpSendMsTotal += nowMs() - sendStart;

  // Retry once if server needs full for some paths (basis mismatch).
  if (!resp.ok && resp.needFull && resp.needFull.length > 0) {
    const need = new Set(resp.needFull);
    const retryPayloads: EncodedPayload[] = [];
    for (const p of encodedPayloads) {
      if (!need.has(p.payload.path)) continue;
      const entry = fileMap.get(p.payload.path);
      if (!entry) continue;
      retryPayloads.push({
        payload: {
          kind: 'full',
          path: entry.path,
          targetSha256: entry.sha256.toLowerCase(),
          length: entry.size,
        },
        filePath: entry.absPath,
      });
    }
    if (retryPayloads.length > 0) {
      slog('warn', `server requested full for ${retryPayloads.length} files; retrying once`);
      const retryMeta: FolderSyncHttpMeta = {
        ...meta,
        id: genId('sync'),
        payloads: retryPayloads.map((p) => p.payload),
      };
      const retryStart = nowMs();
      resp = await httpFolderSyncBatch(
        opts,
        retryMeta,
        retryPayloads.map((p) => ({ filePath: p.filePath })),
      );
      httpSendMsTotal += nowMs() - retryStart;
    }
  }

  // Cleanup patch temp dirs
  await Promise.all(
    encodedPayloads.map(async (p) => {
      if (!p.cleanupDir) return;
      try {
        await fs.promises.rm(p.cleanupDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }),
  );

  // Sync work includes: local hashing + planning + transfers (but excludes finalize/install wait).
  const syncWorkMs = nowMs() - totalStart;
  if (!resp.ok) {
    throw new Error(resp.error ?? 'sync failed');
  }
  const tookMs = nowMs() - totalStart;
  const totalBytes = bytesSentFull + bytesSentDelta;
  slog(
    'info',
    `sync finished files=${files.length} sent=${fmtBytes(totalBytes)} syncWork=${fmtMs(
      syncWorkMs,
    )} total=${fmtMs(tookMs)}`,
  );
  slog('debug', `sync bytes full=${fmtBytes(bytesSentFull)} delta=${fmtBytes(bytesSentDelta)}`);
  slog(
    'debug',
    `timing ensureXdelta3=${fmtMs(tEnsureMs)} walk=${fmtMs(tWalkMs)} httpSend=${fmtMs(
      httpSendMsTotal,
    )} deltaEncode=${fmtMs(deltaEncodeMsTotal)}`,
  );
  const out: SyncFolderResult = {};
  if (resp.installedAppPath) {
    out.installedAppPath = resp.installedAppPath;
  }
  if (resp.bundleId) {
    out.installedBundleId = resp.bundleId;
  }
  // Update local cache optimistically: after a successful sync, cache reflects current local tree.
  for (const f of files) {
    await cachePut(cacheRoot, f.path, f.absPath);
  }
  return out;
}
