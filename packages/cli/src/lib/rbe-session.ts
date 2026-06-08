import fs from 'fs';
import net from 'net';
import path from 'path';
import type { RbeStatus, XcodeClient } from '@limrun/api';

/**
 * Deterministic, side-effect-light helpers behind `lim xcode rbe`, extracted
 * from the command so they can be unit-tested without the oclif lifecycle.
 */

export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Matches the transient gateway / dropped-connection errors that occur right
 * after an instance is created, when its proxy path is not fully serving yet.
 *
 * The HTTP part anchors on the exact `failed: <code>` shape `directInstanceHttpError`
 * produces (`${operation} failed: ${status}...`), so a bare 502/503/504 buried in
 * a response body or an instance id does NOT count as transient. Fetch-thrown
 * network errors carry their own names and are matched directly. A 404 never
 * reaches here — `readRbeResponse` maps it to RbeUnsupportedError first.
 */
const TRANSIENT = /failed: (?:502|503|504)\b|\bEOF\b|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i;

export function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT.test(message);
}

/**
 * Retries `fn` on transient gateway errors. Non-transient errors propagate
 * immediately. After exhausting `attempts`, throws the last error.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: { sleep?: Sleep; log?: (msg: string) => void; attempts?: number } = {},
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = opts.attempts ?? 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientError(err)) {
        throw err;
      }
      lastErr = err;
      if (attempt < attempts) {
        const message = err instanceof Error ? err.message : String(err);
        opts.log?.(`Instance not serving yet (${message.trim()}); retrying...`);
        await sleep(2000 * attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Polls `getRbe` until the stack is `running` (with a usable frontend port and
 * Xcode version), starting from the `initial` status returned by `startRbe`.
 * Each poll is wrapped in retryTransient so a transient blip mid-startup does
 * not abort. Throws when the stack ends in `failed`, stays `starting` past
 * `maxAttempts`, or reports `running` without the fields the caller needs.
 */
export async function waitForRbeRunning(
  client: Pick<XcodeClient, 'getRbe'>,
  initial: RbeStatus,
  opts: { sleep?: Sleep; maxAttempts?: number } = {},
): Promise<Required<Pick<RbeStatus, 'frontendPort' | 'xcodeVersion'>> & RbeStatus> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 15;
  let status = initial;
  for (let attempt = 0; status.state === 'starting' && attempt < maxAttempts; attempt++) {
    await sleep(2000);
    status = await retryTransient(() => client.getRbe(), { sleep });
  }
  if (status.state !== 'running' || !status.frontendPort || !status.xcodeVersion) {
    throw new Error(`Remote-execution stack failed to start: ${status.error ?? `state is ${status.state}`}`);
  }
  return status as Required<Pick<RbeStatus, 'frontendPort' | 'xcodeVersion'>> & RbeStatus;
}

/**
 * Builds the argv for the detached child that holds the tunnel: re-invokes this
 * same CLI as `xcode rbe --serve --id <id> --port <port> [--api-key <key>]`.
 * `scriptPath` is the CLI entry (process.argv[1]).
 */
export function buildServeChildArgs(opts: {
  scriptPath: string;
  id: string;
  port: number;
  apiKey?: string;
}): string[] {
  const args = [opts.scriptPath, 'xcode', 'rbe', '--serve', '--id', opts.id, '--port', String(opts.port)];
  if (opts.apiKey) {
    args.push('--api-key', opts.apiKey);
  }
  return args;
}

/**
 * A running background tunnel's coordinates, persisted to `.limrun/rbe.pid` so
 * `lim xcode rbe --stop` can find and stop it (adb prints the PID and forgets
 * it; we keep just enough to offer a discoverable stop). Lives under `.limrun/`,
 * which is self-gitignored.
 */
export type RbePidInfo = { pid: number; instanceId: string; port: number };

export function rbePidFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.limrun', 'rbe.pid');
}

export function writeRbePidFile(workspaceRoot: string, info: RbePidInfo): void {
  fs.writeFileSync(rbePidFilePath(workspaceRoot), JSON.stringify(info));
}

export function readRbePidFile(workspaceRoot: string): RbePidInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(rbePidFilePath(workspaceRoot), 'utf8'));
    if (parsed && typeof parsed.pid === 'number') {
      return parsed as RbePidInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearRbePidFile(workspaceRoot: string): void {
  try {
    fs.unlinkSync(rbePidFilePath(workspaceRoot));
  } catch {
    // already gone
  }
}

/** Whether `pid` is a live process (treats EPERM — owned by another user — as alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Resolves when `port` on `host` is bindable; rejects with a friendly message
 * when it is already in use, or with the raw error otherwise. Frees the port
 * immediately (the probe listener is closed before resolving).
 */
export async function assertLocalPortFree(port: number, host = '127.0.0.1'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Local port ${port} is already in use. Pass --port to choose another.`));
      } else {
        reject(err);
      }
    });
    probe.once('listening', () => {
      probe.close(() => resolve());
    });
    probe.listen(port, host);
  });
}
