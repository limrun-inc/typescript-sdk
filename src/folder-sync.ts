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
type BeginDeltaBatchMsg = { type: 'beginDeltaBatch'; batchId: string; count: number };
type EndDeltaMsg = { type: 'endDelta'; id: string };
type EndDeltaBatchMsg = { type: 'endDeltaBatch'; batchId: string };
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

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)}KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)}MiB`;
  const gib = mib / 1024;
  return `${gib.toFixed(2)}GiB`;
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

function encodeDeltaChunkFrame(id: string, chunk: Buffer): Buffer {
  const idBytes = Buffer.from(id, 'utf-8');
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(idBytes.length, 0);
  header.writeUInt32BE(chunk.length, 4);
  return Buffer.concat([header, idBytes, chunk]);
}

class FolderSyncWsSession {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;

  private planWaiters = new Map<string, (m: SyncPlanMsg) => void>();
  private resultWaiters = new Map<string, (m: SyncResultMsg) => void>();
  private ackWaiters = new Map<string, (m: ApplyAckMsg) => void>();

  constructor(
    private wsUrl: string,
    private log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void,
  ) {}

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return await this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const cleanup = () => {
        ws.removeAllListeners();
        this.connecting = null;
      };

      ws.on('open', () => {
        this.log('debug', `ws connected`);
        resolve();
      });
      ws.on('error', (e) => {
        cleanup();
        reject(e);
      });
      ws.on('close', () => {
        // Leave waiters; next connect() will recreate socket.
        this.log('debug', `ws closed`);
        cleanup();
      });
      ws.on('message', (data: any) => this.onMessage(data));
    });

    return await this.connecting;
  }

  async connectWithBackoff(opts?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  }): Promise<void> {
    const maxAttempts = opts?.maxAttempts ?? 8;
    const baseDelayMs = opts?.baseDelayMs ?? 200;
    const maxDelayMs = opts?.maxDelayMs ?? 5_000;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.connect();
        return;
      } catch (e) {
        lastErr = e;
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
        this.log(
          'warn',
          `ws connect failed attempt=${attempt}/${maxAttempts} retryIn=${fmtMs(delay)} err=${
            (e as Error).message
          }`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('WebSocket connect failed');
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
  }

  private onMessage(data: any): void {
    let msg: IncomingMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'syncPlan') {
      const w = this.planWaiters.get(msg.id);
      if (w) {
        this.planWaiters.delete(msg.id);
        w(msg);
      }
      return;
    }
    if (msg.type === 'syncResult') {
      const w = this.resultWaiters.get(msg.id);
      if (w) {
        this.resultWaiters.delete(msg.id);
        w(msg);
      }
      return;
    }
    if (msg.type === 'applyAck') {
      const w = this.ackWaiters.get(msg.id);
      if (w) {
        this.ackWaiters.delete(msg.id);
        w(msg);
      }
      return;
    }
  }

  sendJson(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  sendBinary(buf: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(buf);
  }

  waitPlan(syncId: string, timeoutMs = 120_000): Promise<SyncPlanMsg> {
    return this.waitWithTimeout(timeoutMs, (resolve) => this.planWaiters.set(syncId, resolve));
  }

  waitResult(syncId: string, timeoutMs = 300_000): Promise<SyncResultMsg> {
    return this.waitWithTimeout(timeoutMs, (resolve) => this.resultWaiters.set(syncId, resolve));
  }

  waitAck(id: string, timeoutMs = 120_000): Promise<ApplyAckMsg> {
    return this.waitWithTimeout(timeoutMs, (resolve) => this.ackWaiters.set(id, resolve));
  }

  private waitWithTimeout<T>(timeoutMs: number, register: (resolve: (v: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for server response')), timeoutMs);
      register((v) => {
        clearTimeout(t);
        resolve(v);
      });
    });
  }
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

export type SyncAppResult = SyncFolderResult;

export async function syncApp(localFolderPath: string, opts: FolderSyncOptions): Promise<SyncFolderResult> {
  if (!opts.watch) {
    return await syncFolderOnce(localFolderPath, opts);
  }
  // Initial sync, then watch for changes and re-run sync in the background.
  const log = opts.log ?? noopLogger;
  const wsUrl = toWsUrl(opts.apiUrl, opts.token);
  const session = new FolderSyncWsSession(wsUrl, (level, msg) => log(level, `syncApp: ${msg}`));
  await session.connectWithBackoff();

  const first = await syncFolderOnce(localFolderPath, opts, 'startup', session);
  let inFlight = false;
  let queued = false;

  const run = async (reason: string) => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      await syncFolderOnce(localFolderPath, opts, reason, session);
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
      session.close();
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
  session?: FolderSyncWsSession,
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

  const wsUrl = toWsUrl(opts.apiUrl, opts.token);
  const ownsSession = !session;
  const wsSession = session ?? new FolderSyncWsSession(wsUrl, (level, msg) => log(level, `syncApp: ${msg}`));

  const tWsConnectStart = nowMs();
  await wsSession.connectWithBackoff();
  const tWsConnectMs = nowMs() - tWsConnectStart;

  const syncId = genId('sync');
  const rootName = path.basename(path.resolve(localFolderPath));
  const manifestMsg: SyncManifestMsg = {
    type: 'syncManifest',
    id: syncId,
    rootName,
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, mode: f.mode })),
  };
  wsSession.sendJson(manifestMsg);

  const tPlanStart = nowMs();
  const plan = await wsSession.waitPlan(syncId);
  const tPlanMs = nowMs() - tPlanStart;

  const cacheRoot = localBasisCacheRoot(opts);
  await fs.promises.mkdir(cacheRoot, { recursive: true });

  // Track how many bytes we actually transmit to the server.
  let bytesSentFull = 0;
  let bytesSentDelta = 0;
  let fullUploadMsTotal = 0;
  let fullApplyMsTotal = 0;
  let deltaEncodeMsTotal = 0;
  let deltaSendApplyMsTotal = 0;

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
    fullUploadMsTotal += uploadMs;
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
    wsSession.sendJson(applyMsg);
    const ack = await wsSession.waitAck(msgId);
    if (!ack.ok) throw new Error(`applyFull failed for ${relPath}: ${ack.error ?? 'unknown error'}`);
    const applyMs = nowMs() - applyStart;
    fullApplyMsTotal += applyMs;
    const totalMs = nowMs() - start;
    slog(
      'debug',
      `full(done): ${relPath} size=${entry.size} upload=${fmtMs(uploadMs)} apply=${fmtMs(
        applyMs,
      )} total=${fmtMs(totalMs)}`,
    );
    bytesSentFull += entry.size;
    await cachePut(cacheRoot, relPath, entry.absPath);
  };

  // First: do files server says must be full
  for (const f of plan.sendFull) {
    slog('debug', `full(plan): ${f.path} (${f.size} bytes)`);
    await applyFull(f.path, f.sha256);
  }

  // Then: try deltas (encode in parallel, send in a batch, await acks)
  type PlanDelta = SyncPlanMsg['sendDelta'][number];
  type EncodedDelta = {
    plan: PlanDelta;
    entry: FileEntry;
    basisPath: string;
    patchPath: string;
    patchSize: number;
    encodeMs: number;
    tmpDir: string;
  };

  const encodeLimit = concurrencyLimit();
  const encoded: (EncodedDelta | null)[] = await mapLimit(plan.sendDelta, encodeLimit, async (d) => {
    const entry = fileMap.get(d.path);
    if (!entry) return null;
    const basisPath = cacheGet(cacheRoot, d.path);
    if (!fs.existsSync(basisPath)) {
      slog('debug', `delta(skip): ${baseName(d.path)} reason=no_basis`);
      return null;
    }
    const basisSha = await sha256FileHex(basisPath);
    if (basisSha !== d.basisSha256.toLowerCase()) {
      slog('debug', `delta(skip): ${baseName(d.path)} reason=basis_sha_mismatch`);
      return null;
    }
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'limulator-xdelta3-'));
    const patchPath = path.join(tmpDir, 'patch.xdelta3');
    try {
      const encodeStart = nowMs();
      await runXdelta3Encode(basisPath, entry.absPath, patchPath);
      const encodeMs = nowMs() - encodeStart;
      const st = await fs.promises.stat(patchPath);
      if (st.size > maxPatchBytes) {
        slog('debug', `delta(skip): ${baseName(d.path)} patchSize=${st.size} reason=patch_too_big`);
        return null;
      }
      return { plan: d, entry, basisPath, patchPath, patchSize: st.size, encodeMs, tmpDir };
    } catch (e) {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw e;
    }
  });

  const deltasToSend = encoded.filter((x): x is EncodedDelta => x !== null);
  // Any skipped deltas become full uploads.
  const deltaPathsToSend = new Set(deltasToSend.map((d) => d.plan.path));
  for (const d of plan.sendDelta) {
    if (!deltaPathsToSend.has(d.path)) {
      await applyFull(d.path, d.targetSha256);
    }
  }

  if (deltasToSend.length > 0) {
    deltaEncodeMsTotal += deltasToSend.reduce((sum, d) => sum + d.encodeMs, 0);
    const batchId = genId('batch');
    wsSession.sendJson({
      type: 'beginDeltaBatch',
      batchId,
      count: deltasToSend.length,
    } satisfies BeginDeltaBatchMsg);

    const deltaMsgIds: { msgId: string; path: string; patchSize: number; targetSha256: string }[] = [];
    for (const d of deltasToSend) {
      const msgId = genId('delta');
      deltaMsgIds.push({
        msgId,
        path: d.plan.path,
        patchSize: d.patchSize,
        targetSha256: d.plan.targetSha256,
      });
      slog(
        'debug',
        `delta(send): ${baseName(d.plan.path)} patchSize=${d.patchSize} encode=${fmtMs(d.encodeMs)}`,
      );
      const begin: BeginDeltaMsg = {
        type: 'beginDelta',
        id: msgId,
        path: d.plan.path,
        basisSha256: d.plan.basisSha256,
        targetSha256: d.plan.targetSha256,
        patchSize: d.patchSize,
      };
      wsSession.sendJson(begin);

      // Stream patch bytes framed with id header
      const sendStart = nowMs();
      const fd = await fs.promises.open(d.patchPath, 'r');
      try {
        let offset = 0;
        while (offset < d.patchSize) {
          const len = Math.min(64 * 1024, d.patchSize - offset);
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fd.read(buf, 0, len, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
          wsSession.sendBinary(encodeDeltaChunkFrame(msgId, buf.subarray(0, bytesRead)));
        }
      } finally {
        await fd.close();
      }
      wsSession.sendJson({ type: 'endDelta', id: msgId } satisfies EndDeltaMsg);
      const sendMs = nowMs() - sendStart;
      deltaSendApplyMsTotal += sendMs;
    }

    wsSession.sendJson({ type: 'endDeltaBatch', batchId } satisfies EndDeltaBatchMsg);

    // Await acks (as they arrive) after sending the whole batch.
    const acks = await Promise.all(deltaMsgIds.map((d) => wsSession.waitAck(d.msgId)));
    for (let i = 0; i < acks.length; i++) {
      const ack = acks[i]!;
      const info = deltaMsgIds[i]!;
      const { path, patchSize, targetSha256 } = info;
      if (!ack.ok) {
        if (ack.needFull) {
          slog('warn', `delta failed, retrying full for ${path}: ${ack.error ?? 'unknown'}`);
          await applyFull(path, targetSha256);
        } else {
          throw new Error(`delta apply failed for ${path}: ${ack.error ?? 'unknown error'}`);
        }
      } else {
        bytesSentDelta += patchSize;
        const entry = fileMap.get(path);
        if (entry) {
          await cachePut(cacheRoot, path, entry.absPath);
        }
      }
    }

    // Cleanup temp dirs
    await Promise.all(
      deltasToSend.map(async (d) => {
        try {
          await fs.promises.rm(d.tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }),
    );
  }

  // Sync work includes: local hashing + planning + transfers (but excludes finalize/install wait).
  const syncWorkMs = nowMs() - totalStart;
  const finalize: SyncFinalizeMsg = {
    type: 'syncFinalize',
    id: syncId,
    install: opts.install ?? true,
    ...(opts.launchMode ? { launchMode: opts.launchMode } : {}),
  };
  wsSession.sendJson(finalize);

  const installStart = nowMs();
  const result = await wsSession.waitResult(syncId, 300_000);
  if (ownsSession) {
    wsSession.close();
  }

  if (!result.ok) {
    throw new Error(result.error ?? 'sync failed');
  }
  const tookMs = nowMs() - totalStart;
  const installMs = nowMs() - installStart;
  const totalBytes = bytesSentFull + bytesSentDelta;
  slog(
    'info',
    `sync finished files=${files.length} sent=${fmtBytes(totalBytes)} syncWork=${fmtMs(
      syncWorkMs,
    )} install=${fmtMs(installMs)} total=${fmtMs(tookMs)}`,
  );
  slog('debug', `sync bytes full=${fmtBytes(bytesSentFull)} delta=${fmtBytes(bytesSentDelta)}`);
  slog(
    'debug',
    `timing ensureXdelta3=${fmtMs(tEnsureMs)} walk=${fmtMs(tWalkMs)} wsConnect=${fmtMs(
      tWsConnectMs,
    )} plan=${fmtMs(tPlanMs)} fullUpload=${fmtMs(fullUploadMsTotal)} fullApply=${fmtMs(
      fullApplyMsTotal,
    )} deltaEncode=${fmtMs(deltaEncodeMsTotal)} deltaSendApply=${fmtMs(deltaSendApplyMsTotal)}`,
  );
  const out: SyncFolderResult = {};
  if (result.installedAppPath) {
    out.installedAppPath = result.installedAppPath;
  }
  if (result.bundleId) {
    out.installedBundleId = result.bundleId;
  }
  return out;
}
