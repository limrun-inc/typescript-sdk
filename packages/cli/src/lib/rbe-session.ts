import fs from 'fs';
import net from 'net';
import path from 'path';

/**
 * CLI-only helpers behind `lim xcode rbe`: the pidfile/daemon process model and
 * local port probing. The deployment-facing session helpers (isTransientError,
 * retryTransient, waitForRbeRunning, defaultSleep) live in @limrun/api.
 */

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
  autoUpload?: string;
  uploadTtl?: string;
}): string[] {
  // --no-create: the child must never own instance creation. The parent already
  // resolved/created the instance and started RBE on it; if that instance has
  // vanished by the time the child resolves it, the child should fail cleanly
  // rather than spin up a stray instance the parent never started a stack on.
  const args = [
    opts.scriptPath,
    'xcode',
    'rbe',
    '--serve',
    '--no-create',
    '--id',
    opts.id,
    '--port',
    String(opts.port),
  ];
  if (opts.apiKey) {
    args.push('--api-key', opts.apiKey);
  }
  if (opts.autoUpload) {
    args.push('--auto-upload', opts.autoUpload);
    if (opts.uploadTtl) {
      args.push('--upload-ttl', opts.uploadTtl);
    }
  }
  return args;
}

/**
 * A running background tunnel's coordinates, persisted to `.limrun/rbe.pid` so
 * `lim xcode rbe --stop` can find and stop it (adb prints the PID and forgets
 * it; we keep just enough to offer a discoverable stop). Lives under `.limrun/`,
 * which is self-gitignored.
 */
export type RbePidInfo = {
  pid: number;
  instanceId: string;
  port: number;
  /** iOS simulator created by `--ios`, torn down on --stop. Absent otherwise. */
  simInstanceId?: string;
  /** Asset name the tunnel auto-uploads successful builds to. Absent when off. */
  autoUpload?: string;
  uploadTtl?: string;
};

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

/**
 * Resolves true if a TCP connection to `host:port` is accepted (something is
 * listening), false otherwise (connection refused, error, or no answer within
 * `timeoutMs`). The timeout only bites when a connect neither completes nor is
 * refused (a dropped SYN); on loopback a closed port refuses instantly.
 */
export function probePortOpen(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}
