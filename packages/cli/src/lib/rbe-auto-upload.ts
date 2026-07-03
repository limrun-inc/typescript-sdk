import { setTimeout as sleepFor } from 'node:timers/promises';
import type { XcodeClient } from '@limrun/api';

/**
 * Watches the instance's Bazel builds and uploads every successful one as the
 * named asset, so a preview link stays current with no post-build step. Runs
 * inside the process that holds the RBE tunnel (the detached serve child, or
 * the foreground --no-daemon command).
 *
 * Discovery is a poll of the active-invocations list; the per-invocation event
 * stream replays from the start on subscribe, so any invocation observed while
 * running delivers its terminal event. Even an all-cache-hit remote build's
 * invocation window is ~3s (analysis plus BES round trips), so the poll cannot
 * miss one. An invocation that vanishes from the list before its stream could
 * be read (a dropped stream) takes the fallback: upload the latest successful
 * build anyway. That is content-idempotent when the vanished build failed (it
 * re-ships the previous artifact), and a no-op error when nothing succeeded
 * yet, both logged.
 */
export function startAutoUploadWatcher(opts: {
  client: Pick<XcodeClient, 'getActiveRbeBuilds' | 'waitForRbeBuildEnd' | 'uploadLatestRbeBuild'>;
  assetName: string;
  ttl?: string;
  log: (msg: string) => void;
  pollMs?: number;
  goneGraceMs?: number;
}): { stop: () => Promise<void> } {
  const { client, assetName, ttl, log } = opts;
  const pollMs = opts.pollMs ?? 1000;
  const abort = new AbortController();
  // Abort-aware sleep so stop() never has to wait out a pending delay (the
  // failure backoff can reach 10x pollMs, which would stall process exit).
  const sleep = (ms: number) => sleepFor(ms, undefined, { signal: abort.signal }).catch(() => undefined);
  // Every invocation ever registered, kept for the watcher's lifetime:
  // invocation ids are unique, and a completed build can still appear in an
  // in-flight poll response, so dropping ids on completion would re-watch and
  // re-upload the same build. Bounded by builds per tunnel session.
  const seen = new Set<string>();
  // Serialize uploads: each ships the daemon's latest record, so a second
  // build finishing mid-upload just refreshes the asset again right after.
  let uploadChain = Promise.resolve();
  let pollFailures = 0;

  const upload = (reason: string) => {
    uploadChain = uploadChain.then(async () => {
      if (abort.signal.aborted) return;
      try {
        const result = await client.uploadLatestRbeBuild({ assetName, ...(ttl && { ttl }) });
        log(`auto-upload: uploaded ${result.appName} as "${assetName}"${reason ? ` (${reason})` : ''}`);
      } catch (err) {
        log(`auto-upload: upload failed: ${err instanceof Error ? err.message : err}`);
      }
    });
    return uploadChain;
  };

  // Bounds how long a wait may outlive its invocation's disappearance from the
  // active list before it is aborted. A build's end frame normally settles the
  // wait itself; this guard covers a stream that goes silent without closing
  // (observed once: a half-open SSE kept a wait pending forever, silently
  // dropping the upload).
  const goneGraceMs = opts.goneGraceMs ?? 10_000;
  const livenessMs = Math.max(1, Math.min(5000, goneGraceMs / 2));

  const watch = async (invocationId: string) => {
    if (abort.signal.aborted) {
      // A poll in flight when stop() was called can still deliver invocations;
      // an abort listener added to an already-aborted signal never fires, so
      // starting a wait here would outlive the watcher.
      return;
    }
    for (;;) {
      // Liveness guard alongside the wait: once the invocation leaves the
      // active list, the end frame either already settled the wait or never
      // will; give it a grace period, then abort so the fallback runs.
      const waitAbort = new AbortController();
      const onWatcherStop = () => waitAbort.abort();
      abort.signal.addEventListener('abort', onWatcherStop, { once: true });
      let goneSince: number | undefined;
      const liveness = setInterval(() => {
        void client
          .getActiveRbeBuilds()
          .then((builds) => {
            if (builds.some((b) => b.invocationId === invocationId)) {
              goneSince = undefined;
            } else {
              goneSince ??= Date.now();
              if (Date.now() - goneSince >= goneGraceMs) {
                waitAbort.abort();
              }
            }
          })
          .catch(() => undefined);
      }, livenessMs);

      try {
        const end = await client.waitForRbeBuildEnd(invocationId, { signal: waitAbort.signal });
        if (end.status === 'SUCCEEDED') {
          await upload('');
        } else {
          log(`auto-upload: build ${invocationId} ${end.status}; skipping upload`);
        }
        return;
      } catch (err) {
        if (abort.signal.aborted) return;
        // A FAILED probe counts as still-active, not gone: during a daemon
        // restart or network blip both calls fail together, and treating that
        // as gone would fire the fallback prematurely and permanently abandon
        // a running build (seen never forgets). The liveness guard, which only
        // counts successful observations, remains the authority on gone-ness.
        const stillActive = await client
          .getActiveRbeBuilds()
          .then((builds) => builds.some((b) => b.invocationId === invocationId))
          .catch(() => true);
        if (abort.signal.aborted) return;
        if (!stillActive) {
          log(`auto-upload: build ${invocationId} ended with unknown status; uploading latest build`);
          await upload('end status unknown');
          return;
        }
        // Pace the re-subscribe: a fast-rejecting stream with a healthy active
        // list must not hot-loop against the daemon.
        await sleep(pollMs);
      } finally {
        clearInterval(liveness);
        abort.signal.removeEventListener('abort', onWatcherStop);
      }
    }
  };

  const pollLoop = async () => {
    while (!abort.signal.aborted) {
      try {
        const builds = await client.getActiveRbeBuilds();
        pollFailures = 0;
        for (const build of builds) {
          if (!seen.has(build.invocationId)) {
            seen.add(build.invocationId);
            void watch(build.invocationId);
          }
        }
      } catch (err) {
        // Log the first failure of a streak, then back off linearly; the
        // tunnel process must survive daemon restarts and network blips.
        pollFailures++;
        if (pollFailures === 1) {
          log(`auto-upload: polling failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      await sleep(pollMs * Math.min(pollFailures + 1, 10));
    }
  };
  void pollLoop();

  return {
    // Aborting skips queued uploads, but an upload already in flight is a
    // completed build's artifact: return it so shutdown can wait instead of
    // cancelling it at process exit. Callers' own grace periods (a second
    // Ctrl-C, --stop's SIGKILL escalation) bound a wedged one.
    stop: () => {
      abort.abort();
      return uploadChain;
    },
  };
}
