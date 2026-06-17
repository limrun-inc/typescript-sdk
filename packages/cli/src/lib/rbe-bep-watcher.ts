import fs from 'fs';
import path from 'path';
import { inspectBuildCompletion, parseTopLevelIpaDigest, RbeBepError } from '@limrun/api';
import type { BepIpaDigest, XcodeClient } from '@limrun/api';

/**
 * Watches a workspace's `.limrun/bep.json` and, after each completed build,
 * registers the built target's `.ipa` with the instance so it is installed on
 * the attached simulator now (and replayed on a later attach). This is the
 * client-side trigger for `lim xcode rbe` auto-install: only Bazel (on the
 * client) knows the build finished and which CAS digest is the top-level `.ipa`,
 * so the daemon holding the tunnel watches the BEP and the instance does the
 * install server-side.
 *
 * Robustness is the priority: this runs inside the detached daemon that holds
 * the only RBE tunnel, so every read/parse/HTTP error is caught and logged, and
 * the watcher never throws into the daemon (a crash here would drop the tunnel
 * mid-build). It is also idempotent: it acts once per Bazel invocation, even
 * when a build reproduces an earlier `.ipa` digest (e.g. a `git stash` revert),
 * because the instance keys "already installed" on the CAS digest.
 */

export type BepWatcherOptions = {
  /** Absolute path to Bazel's build-event JSON log (`--build_event_json_file`). */
  bepPath: string;
  /** The build target to select from the BEP and install (e.g. //App:App). */
  target: string;
  /** Returns the XcodeClient to use; called per install so a refreshed client is picked up. */
  getClient: () => XcodeClient;
  /** Sink for status/diagnostic lines (the daemon redirects stdout/stderr to .limrun/rbe.log). */
  log: (msg: string) => void;
  /** Debounce window after a BEP change before acting. */
  debounceMs?: number;
  /** mtime-poll backstop interval (covers FSEvents coalescing/drops on macOS). */
  pollIntervalMs?: number;
  /** Delay before retrying a build after a transient install failure. */
  retryDelayMs?: number;
  /** Max transient-failure retries for one build before giving up (rebuild to retry). */
  maxRetries?: number;
};

export type BepWatcher = {
  /** Stops watching and awaits any in-flight registration. Idempotent. */
  close: () => Promise<void>;
};

export function startBepWatcher(opts: BepWatcherOptions): BepWatcher {
  const {
    bepPath,
    target,
    getClient,
    log,
    debounceMs = 400,
    pollIntervalMs = 1500,
    retryDelayMs = 5000,
    maxRetries = 3,
  } = opts;

  const watchDir = path.dirname(bepPath);
  const bepName = path.basename(bepPath);

  // Act once per build. We dedupe on the Bazel invocation id (not the digest) so
  // a rebuild that reproduces an earlier digest (git stash revert) still
  // re-registers — the instance, keyed on the CAS digest, then reinstalls only
  // if the on-sim digest actually differs. When a BEP carries no invocation id
  // (older Bazel), we fall back to the digest hash so we still avoid re-acting on
  // the same build's repeated change events.
  let lastHandledInvocation: string | undefined;
  let lastHandledHash: string | undefined;
  let authExpired = false;
  const loggedOnce = new Set<string>();

  let closed = false;
  let dirty = false;
  let currentTick: Promise<void> | null = null;
  // Bounded retry for transient install failures (the mtime/size poll only fires
  // on a file change, so a settled build wouldn't otherwise be retried).
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryInvocation: string | undefined;
  let retryCount = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Seed from the current file (if any) so the first poll doesn't spuriously fire,
  // and so we notice a rewrite by size even when mtime granularity is coarse.
  let lastMtimeMs = -1;
  let lastSize = -1;
  try {
    const st = fs.statSync(bepPath);
    lastMtimeMs = st.mtimeMs;
    lastSize = st.size;
  } catch {
    /* no BEP yet */
  }

  const logOnce = (key: string, msg: string): void => {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    log(msg);
  };

  const trigger = (): void => {
    if (closed) return;
    if (currentTick) {
      // A tick is in flight; mark dirty so we re-run once it settles.
      dirty = true;
      return;
    }
    currentTick = tick()
      .catch((err) => log(`auto-install: unexpected error: ${errMsg(err)}`))
      .finally(() => {
        currentTick = null;
        // A BEP change during the registration (e.g. a new build) set `dirty`;
        // re-run so we converge on the latest on-disk build.
        if (dirty && !closed) {
          dirty = false;
          trigger();
        }
      });
  };

  const onChange = (): void => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      trigger();
    }, debounceMs);
  };

  async function tick(): Promise<void> {
    if (authExpired) return; // a detached daemon cannot relogin; stop trying.
    if (closed) return;
    let bep: string;
    try {
      bep = await fs.promises.readFile(bepPath, 'utf8');
    } catch {
      return; // file missing/unreadable; a later change re-triggers.
    }

    const completion = inspectBuildCompletion(bep);
    if (!completion.complete || !completion.success) {
      // Build still flushing, or it failed: leave prior state untouched. A
      // failed build must not register anything.
      return;
    }
    if (completion.invocationId && completion.invocationId === lastHandledInvocation) {
      return; // already handled this build.
    }

    // The BEP is fully flushed (gated on the terminal `lastMessage` event), so a
    // parse failure here is definitive, not a not-yet-written race: this build
    // either didn't produce our target or used wrong flags (BLAKE3 / local-only).
    // Either way, mark the build handled so its remaining change events don't
    // reprocess; log the wrong-flags case once.
    let digest: BepIpaDigest;
    try {
      digest = parseTopLevelIpaDigest(bep, target);
    } catch (err) {
      if (err instanceof RbeBepError && err.terminal) {
        logOnce(`terminal:${completion.invocationId ?? 'no-invocation'}`, `auto-install: ${errMsg(err)}`);
      }
      markHandled(completion.invocationId, undefined);
      return;
    }

    // Fall back to the digest for the rare BEP without an invocation id, so the
    // same build's repeated change events don't re-register.
    if (!completion.invocationId && digest.hash === lastHandledHash) {
      return;
    }

    await register(bep, digest, completion.invocationId);
  }

  function markHandled(invocationId: string | undefined, hash: string | undefined): void {
    // Update each dedupe key only when we actually have a value, so a terminal
    // parse failure (which has an invocation id but no digest) doesn't wipe the
    // hash-fallback key used for invocation-less BEP streams.
    if (invocationId !== undefined) lastHandledInvocation = invocationId;
    if (hash !== undefined) lastHandledHash = hash;
  }

  /**
   * Schedules a re-attempt after a transient install failure (the build is not
   * marked handled, so the re-triggered tick re-reads and retries the same
   * build). Bounded per build: after maxRetries we give up and mark it handled so
   * a permanent failure can't loop forever — the user rebuilds to retry.
   */
  function scheduleRetry(invocationId: string | undefined, digest: BepIpaDigest): void {
    if (closed) return;
    if (invocationId !== retryInvocation) {
      retryInvocation = invocationId;
      retryCount = 0;
    }
    if (retryCount >= maxRetries) {
      logOnce(
        `giveup:${invocationId ?? digest.hash}`,
        `auto-install: gave up installing ${digest.ipaName} after ${maxRetries} retries; rebuild to retry.`,
      );
      markHandled(invocationId, digest.hash);
      return;
    }
    retryCount++;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      trigger();
    }, retryDelayMs);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  async function register(bep: string, digest: BepIpaDigest, invocationId?: string): Promise<void> {
    let result;
    try {
      result = await getClient().installRbeBuildFromBep({ bep, target });
    } catch (err) {
      if (isAuthError(err)) {
        authExpired = true;
        logOnce('auth', 'auto-install: session expired; restart `lim xcode rbe` to resume auto-install.');
        return;
      }
      // Transient (network/instance blip). The mtime/size poll won't re-fire for
      // a settled build, so schedule a bounded retry rather than dropping it until
      // the next build.
      log(`auto-install: failed to install ${digest.ipaName}: ${errMsg(err)}`);
      scheduleRetry(invocationId, digest);
      return;
    }

    // The build is handled — don't retry it on the next change.
    markHandled(invocationId, digest.hash);
    if (result.installed) {
      const timing =
        result.syncDurationMs !== undefined ?
          ` (synced ${result.syncDurationMs}ms, installed ${result.installDurationMs ?? 0}ms)`
        : '';
      log(`auto-install: installed ${result.appName ?? digest.ipaName}${timing}`);
    } else {
      log(`auto-install: recorded ${digest.ipaName}; will install when a simulator is attached.`);
    }
  }

  // fs.watch on the directory (Bazel truncates+rewrites bep.json, changing the
  // inode, so watching the file path directly is unreliable). Filter to bep.json.
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(watchDir, (_event, filename) => {
      if (!filename || path.basename(filename.toString()) === bepName) onChange();
    });
    watcher.on('error', (err) => log(`auto-install: watch error: ${errMsg(err)}`));
  } catch (err) {
    log(`auto-install: could not watch ${watchDir}: ${errMsg(err)}`);
  }

  // mtime-poll backstop: macOS FSEvents can coalesce or drop the single
  // completion event, so also poll the BEP's mtime and act on a change.
  const poll = setInterval(() => {
    fs.promises
      .stat(bepPath)
      .then((st) => {
        // Compare size too: a fast cached rebuild's truncate+rewrite can land
        // within one mtime tick on coarse-granularity filesystems.
        if (st.mtimeMs !== lastMtimeMs || st.size !== lastSize) {
          lastMtimeMs = st.mtimeMs;
          lastSize = st.size;
          onChange();
        }
      })
      .catch(() => {
        /* no BEP yet */
      });
  }, pollIntervalMs);
  // Don't let the poll timer keep the event loop alive on its own.
  if (typeof poll.unref === 'function') poll.unref();

  // Catch a build that completed before the watcher started (e.g. daemon restart).
  trigger();

  return {
    async close(): Promise<void> {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(poll);
      watcher?.close();
      if (currentTick) {
        try {
          await currentTick;
        } catch {
          /* already logged */
        }
      }
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Detects an expired/invalid session (HTTP 401). The SDK throws a typed
 * AuthenticationError (status 401) on some paths; the instance-direct path
 * (installRbeBuildFromBep) instead throws a plain Error whose message is
 * `"<op> failed: <status> <body>"`. Match the status POSITION (`failed: 401`),
 * not a bare `401` anywhere — a transient 5xx whose body merely contains "401"
 * (a trace id, a JSON offset) must not latch auto-install off.
 */
function isAuthError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; status?: number };
    if (e.name === 'AuthenticationError' || e.status === 401) return true;
  }
  return /\bfailed: 401\b/.test(errMsg(err));
}
