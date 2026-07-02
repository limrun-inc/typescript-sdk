import type { RbeStatus, XcodeClient } from './resources/xcode-instances-helpers';

/**
 * Client-side helpers for driving an instance's RBE stack: waiting for it to
 * come up and riding out the transient gateway errors that occur right after
 * instance creation. Shared by the CLI and pure-SDK consumers (e.g. CI
 * actions).
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
 * reaches here; `readRbeResponse` maps it to RbeUnsupportedError first.
 */
const TRANSIENT = /failed: (?:502|503|504)\b|\bEOF\b|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i;

export function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT.test(message);
}

/**
 * Retries `fn` on transient gateway errors (or on whatever `retryOn` matches
 * when given). Non-matching errors propagate immediately. After exhausting
 * `attempts`, throws the last error.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: {
    sleep?: Sleep;
    log?: (msg: string) => void;
    attempts?: number;
    retryOn?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = opts.attempts ?? 5;
  const retryOn = opts.retryOn ?? isTransientError;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!retryOn(err)) {
        throw err;
      }
      lastErr = err;
      if (attempt < attempts) {
        const message = err instanceof Error ? err.message : String(err);
        opts.log?.(`Retrying after error (${message.trim()})...`);
        await sleep(2000 * attempt);
      }
    }
  }
  throw lastErr;
}

/** RbeStatus once the stack is running: frontendPort and xcodeVersion are set. */
export type RunningRbeStatus = RbeStatus & Required<Pick<RbeStatus, 'frontendPort' | 'xcodeVersion'>>;

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
): Promise<RunningRbeStatus> {
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
  return status as RunningRbeStatus;
}
