import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** How long a background command gets to report it is ready before it counts as failed. */
export const DETACHED_READY_MS = 30_000;

export interface DetachedCommand {
  /** The background process; `kill <pid>` stops it. */
  pid: number;
  /** Where the background process writes its messages and errors. */
  logPath: string;
  /** The JSON the command prints once it is ready, such as the port it listens on. */
  ready: Record<string, unknown>;
}

/** The folder background commands keep their output in. */
export function detachedDirectory(): string {
  return path.join(os.homedir(), '.lim', 'detached');
}

/**
 * startDetached runs `lim <args> --no-detach --json` in a background process that outlives this
 * one, and returns once it prints its ready JSON. Long-running commands such as forwards and
 * tunnels use it, so they return the terminal by default. The child is ready only once it holds
 * what it serves, such as a bound port, so a port another process holds fails it rather than
 * passing. `name` prefixes the run's files, such as `ios-forward-<instance>-8100`.
 */
export async function startDetached(opts: {
  name: string;
  args: string[];
  timeoutMs?: number;
}): Promise<DetachedCommand> {
  const directory = detachedDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Each run gets files of its own: two runs of one command, such as forwards to port 0, must not
  // read each other's ready JSON.
  const run = `${opts.name}-${randomUUID().slice(0, 8)}`;
  const logPath = path.join(directory, `${run}.log`);
  // stdout carries only the ready JSON under --json, so it gets a file of its own to parse.
  const readyPath = path.join(directory, `${run}.ready.json`);
  const logFd = fs.openSync(logPath, 'w', 0o600);
  const readyFd = fs.openSync(readyPath, 'w', 0o600);
  const child = spawn(process.execPath, [process.argv[1]!, ...opts.args, '--no-detach', '--json'], {
    detached: true,
    // Without it Windows opens a console window for every background command.
    windowsHide: true,
    stdio: ['ignore', readyFd, logFd],
  });
  fs.closeSync(logFd);
  fs.closeSync(readyFd);
  child.unref();
  if (child.pid === undefined) throw new Error('Failed to start the background process.');
  const pid = child.pid;

  let exited: number | null | undefined;
  child.once('exit', (code) => (exited = code));
  const deadline = Date.now() + (opts.timeoutMs ?? DETACHED_READY_MS);
  while (exited === undefined && Date.now() < deadline) {
    const ready = readReady(readyPath);
    if (ready) return { pid, logPath, ready };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // A process that printed its JSON just before the last check still counts as ready.
  const ready = exited === undefined ? readReady(readyPath) : undefined;
  if (ready) return { pid, logPath, ready };
  if (exited === undefined) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  const tail =
    fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-10).join('\n') : '';
  throw new Error(
    `The background process ${
      exited === undefined ? 'did not become ready in time' : `exited during startup (code ${exited})`
    }.` + `${tail ? `\n${tail}` : ''}\nSee ${logPath} for details, or run with --no-detach.`,
  );
}

function readReady(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    // Not written yet, or written only in part.
    return undefined;
  }
}

/** The flags a background command repeats so it runs as this one does. */
export function inheritedFlags(flags: Record<string, unknown>): string[] {
  return typeof flags['api-key'] === 'string' ? ['--api-key', flags['api-key']] : [];
}
