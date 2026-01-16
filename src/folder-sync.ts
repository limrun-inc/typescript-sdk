import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { watchFolderTree } from './folder-sync-watcher';

// =============================================================================
// Folder Sync (hybrid HTTP + WebSocket)
// - WebSocket: control messages + xdelta3 patch payloads
// - HTTP (/files): full file uploads
// =============================================================================

export type FolderSyncOptions = {
  apiUrl: string;
  token: string;
  udid: string; // used only for local cache scoping
  install?: boolean;
  launchMode?: 'ForegroundIfRunning' | 'RelaunchIfRunning' | 'FailIfRunning';
  /** If true, watch the folder and re-sync on any changes (debounced, single-flight). */
  watch?: boolean;
  /** Max patch size (bytes) to send via WebSocket before falling back to HTTP full upload. */
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

type SyncManifestMsg = {
  type: 'syncManifest';
  id: string;
  rootName: string;
  files: { path: string; size: number; sha256: string; mode: number }[];
};
type SyncPlanMsg = {
  type: 'syncPlan';
  id: string;
  sendFull: { path: string; size: number; sha256: string }[];
  sendDelta: { path: string; basisSha256: string; targetSha256: string }[];
  delete: string[];
};
type ApplyFullFromUploadMsg = {
  type: 'applyFullFromUpload';
  id: string;
  path: string;
  uploadedPath: string;
  sha256: string;
  size?: number;
};
type BeginDeltaMsg = {
  type: 'beginDelta';
  id: string;
  path: string;
  basisSha256: string;
  targetSha256: string;
  patchSize: number;
};
type SyncFinalizeMsg = {
  type: 'syncFinalize';
  id: string;
  install?: boolean;
  launchMode?: 'ForegroundIfRunning' | 'RelaunchIfRunning' | 'FailIfRunning';
};
type ApplyAckMsg = {
  type: 'applyAck';
  id: string;
  path?: string;
  ok: boolean;
  error?: string;
  needFull?: boolean;
};
type SyncResultMsg = {
  type: 'syncResult';
  id: string;
  ok: boolean;
  installedAppPath?: string;
  bundleId?: string;
  error?: string;
};

type IncomingMsg = SyncPlanMsg | ApplyAckMsg | SyncResultMsg;

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

function baseName(p: string): string {
  // We use posix-style relative paths in the sync protocol.
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

function toWsUrl(apiUrl: string, token: string): string {
  return `${apiUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/folder-sync?token=${token}`;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function ensureXdelta3(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('xdelta3', ['-V']);
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`xdelta3 not available (exit=${code})`));
    });
  });
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

async function httpUploadFile(
  apiUrl: string,
  token: string,
  name: string,
  filePath: string,
): Promise<string> {
  const params = new URLSearchParams({ name });
  const uploadUrl = `${apiUrl}/files?${params.toString()}`;
  const fileStream = fs.createReadStream(filePath);
  // Node's fetch (undici) supports streaming request bodies but TS DOM types may not include
  // `duplex` and may not accept Node ReadStreams as BodyInit in some configs.
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(filePath).size.toString(),
      Authorization: `Bearer ${token}`,
    },
    body: fileStream as any,
    duplex: 'half' as any,
  } as any);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { path: string };
  return json.path;
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

function wsSendJson(ws: WebSocket, msg: any): void {
  ws.send(JSON.stringify(msg));
}

async function wsWaitFor<T extends IncomingMsg>(
  ws: WebSocket,
  predicate: (m: IncomingMsg) => m is T,
  timeoutMs = 120_000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMsg = (data: any) => {
      try {
        const raw = JSON.parse(data.toString()) as IncomingMsg;
        if (predicate(raw)) {
          cleanup();
          resolve(raw);
        }
      } catch {
        // ignore
      }
    };
    const onErr = (e: any) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed'));
    };
    const cleanup = () => {
      clearTimeout(t);
      ws.off('message', onMsg);
      ws.off('error', onErr);
      ws.off('close', onClose);
    };
    ws.on('message', onMsg);
    ws.on('error', onErr);
    ws.on('close', onClose);
  });
}

async function wsSendBinaryFile(ws: WebSocket, filePath: string, chunkSize = 64 * 1024): Promise<void> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const st = await fd.stat();
    let offset = 0;
    while (offset < st.size) {
      const len = Math.min(chunkSize, st.size - offset);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fd.read(buf, 0, len, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      ws.send(buf.subarray(0, bytesRead));
    }
  } finally {
    await fd.close();
  }
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
    stopWatching: () => watcher.close(),
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

  await ensureXdelta3();

  const files = await walkFiles(localFolderPath);
  const fileMap = new Map(files.map((f) => [f.path, f]));
  slog('info', `manifest built: ${files.length} files${reason ? ` reason=${reason}` : ''}`);

  const wsUrl = toWsUrl(opts.apiUrl, opts.token);
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e));
  });

  const syncId = genId('sync');
  const rootName = path.basename(path.resolve(localFolderPath));
  const manifestMsg: SyncManifestMsg = {
    type: 'syncManifest',
    id: syncId,
    rootName,
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, mode: f.mode })),
  };
  wsSendJson(ws, manifestMsg);

  const plan = await wsWaitFor(ws, (m): m is SyncPlanMsg => m.type === 'syncPlan' && m.id === syncId);

  const cacheRoot = localBasisCacheRoot(opts);
  await fs.promises.mkdir(cacheRoot, { recursive: true });

  // Helper: perform full upload + apply
  const applyFull = async (relPath: string, expectedSha: string): Promise<void> => {
    const start = nowMs();
    const entry = fileMap.get(relPath);
    if (!entry) throw new Error(`Missing local file for ${relPath}`);
    const tmpName = `folder-sync-${syncId}-${relPath.replace(/\//g, '__')}`;
    slog('debug', `full(upload): ${relPath} size=${entry.size}`);
    const uploadStart = nowMs();
    const uploadedPath = await httpUploadFile(opts.apiUrl, opts.token, tmpName, entry.absPath);
    const uploadMs = nowMs() - uploadStart;
    slog('debug', `full(upload): ${relPath} took=${fmtMs(uploadMs)}`);
    const msgId = genId('full');
    const applyMsg: ApplyFullFromUploadMsg = {
      type: 'applyFullFromUpload',
      id: msgId,
      path: relPath,
      uploadedPath,
      sha256: expectedSha,
      size: entry.size,
    };
    slog('debug', `full(apply): ${relPath} size=${entry.size}`);
    const applyStart = nowMs();
    wsSendJson(ws, applyMsg);
    const ack = await wsWaitFor(ws, (m): m is ApplyAckMsg => m.type === 'applyAck' && m.id === msgId);
    if (!ack.ok) throw new Error(`applyFull failed for ${relPath}: ${ack.error ?? 'unknown error'}`);
    const applyMs = nowMs() - applyStart;
    const totalMs = nowMs() - start;
    slog(
      'debug',
      `full(done): ${relPath} size=${entry.size} upload=${fmtMs(uploadMs)} apply=${fmtMs(
        applyMs,
      )} total=${fmtMs(totalMs)}`,
    );
    await cachePut(cacheRoot, relPath, entry.absPath);
  };

  // First: do files server says must be full
  for (const f of plan.sendFull) {
    log('info', `full: ${f.path} (${f.size} bytes)`);
    await applyFull(f.path, f.sha256);
  }

  // Then: try deltas
  for (const d of plan.sendDelta) {
    const entry = fileMap.get(d.path);
    if (!entry) continue;
    const basisPath = cacheGet(cacheRoot, d.path);
    const basisExists = fs.existsSync(basisPath);
    if (!basisExists) {
      slog('info', `delta->full (no basis): ${d.path}`);
      slog('debug', `delta(skip): ${baseName(d.path)} reason=no_basis`);
      await applyFull(d.path, d.targetSha256);
      continue;
    }
    const basisSha = await sha256FileHex(basisPath);
    if (basisSha !== d.basisSha256.toLowerCase()) {
      slog('info', `delta->full (basis sha mismatch): ${d.path}`);
      slog('debug', `delta(skip): ${baseName(d.path)} reason=basis_sha_mismatch`);
      await applyFull(d.path, d.targetSha256);
      continue;
    }

    // Build patch in temp dir
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'limulator-xdelta3-'));
    const patchPath = path.join(tmpDir, 'patch.xdelta3');
    try {
      const encodeStart = nowMs();
      await runXdelta3Encode(basisPath, entry.absPath, patchPath);
      const encodeMs = nowMs() - encodeStart;
      const st = await fs.promises.stat(patchPath);
      if (st.size > maxPatchBytes) {
        slog('info', `delta->full (patch too big ${st.size} bytes): ${d.path}`);
        slog('debug', `delta(skip): ${baseName(d.path)} patchSize=${st.size} reason=patch_too_big`);
        await applyFull(d.path, d.targetSha256);
        continue;
      }

      const msgId = genId('delta');
      slog('debug', `delta(send): ${baseName(d.path)} patchSize=${st.size} encode=${fmtMs(encodeMs)}`);
      const begin: BeginDeltaMsg = {
        type: 'beginDelta',
        id: msgId,
        path: d.path,
        basisSha256: d.basisSha256,
        targetSha256: d.targetSha256,
        patchSize: st.size,
      };
      const sendStart = nowMs();
      wsSendJson(ws, begin);
      await wsSendBinaryFile(ws, patchPath);
      const ack = await wsWaitFor(ws, (m): m is ApplyAckMsg => m.type === 'applyAck' && m.id === msgId);
      const sendMs = nowMs() - sendStart;
      if (!ack.ok) {
        if (ack.needFull) {
          slog('warn', `delta failed, retrying full for ${d.path}: ${ack.error ?? 'unknown'}`);
          await applyFull(d.path, d.targetSha256);
        } else {
          throw new Error(`delta apply failed for ${d.path}: ${ack.error ?? 'unknown error'}`);
        }
      } else {
        slog(
          'debug',
          `delta(done): ${baseName(d.path)} patchSize=${st.size} total=${fmtMs(encodeMs + sendMs)}`,
        );
        await cachePut(cacheRoot, d.path, entry.absPath);
      }
    } finally {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  const finalize: SyncFinalizeMsg = {
    type: 'syncFinalize',
    id: syncId,
    install: opts.install ?? true,
    ...(opts.launchMode ? { launchMode: opts.launchMode } : {}),
  };
  wsSendJson(ws, finalize);

  const result = await wsWaitFor(
    ws,
    (m): m is SyncResultMsg => m.type === 'syncResult' && m.id === syncId,
    300_000,
  );
  ws.close();

  if (!result.ok) {
    throw new Error(result.error ?? 'sync failed');
  }
  slog('debug', `total: files=${files.length} took=${fmtMs(nowMs() - totalStart)}`);
  const out: SyncFolderResult = {};
  if (result.installedAppPath) {
    out.installedAppPath = result.installedAppPath;
  }
  if (result.bundleId) {
    out.installedBundleId = result.bundleId;
  }
  return out;
}
