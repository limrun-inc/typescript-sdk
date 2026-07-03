import { setTimeout as sleepFor } from 'node:timers/promises';
import type { RbeBuildSummary, XcodeClient } from '@limrun/api';

// The daemon reports exactly these terminal statuses; anything else is in
// flight (RUNNING today; treat unknown future statuses the same so they are
// not permanently marked handled before reaching a terminal state).
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'INCOMPLETE']);

/** Whether the build provably started after `armedAt`. The wire carries
 *  startedAt even though the published type does not declare it yet; absent
 *  or unparsable values count as not-after (the conservative baseline side).
 *  Client/daemon clock skew is negligible against the seconds-wide window
 *  this disambiguates. */
function startedAfter(build: RbeBuildSummary, armedAt: number): boolean {
  const startedAt = (build as { startedAt?: string | null }).startedAt;
  if (!startedAt) return false;
  const t = Date.parse(startedAt);
  return !Number.isNaN(t) && t >= armedAt;
}

/**
 * Watches the instance's Bazel builds and uploads every successful one as the
 * named asset, so a preview link stays current with no post-build step. Runs
 * inside the process that holds the RBE tunnel (the detached serve child, or
 * the foreground --no-daemon command).
 *
 * One poll loop over the daemon's recent-builds view, which lists in-flight
 * invocations plus recently finished ones with their terminal status. A build
 * that starts and finishes between polls (or during a polling outage) still
 * surfaces there afterwards, so nothing else is needed for reliable build-end
 * delivery. The first successful poll is the baseline: builds already terminal
 * at that point predate arming and are not uploaded.
 */
export function startAutoUploadWatcher(opts: {
  client: Pick<XcodeClient, 'getRecentRbeBuilds' | 'uploadLatestRbeBuild'>;
  assetName: string;
  ttl?: string;
  log: (msg: string) => void;
  pollMs?: number;
}): { stop: () => Promise<void> } {
  const { client, assetName, ttl, log } = opts;
  const pollMs = opts.pollMs ?? 1000;
  const abort = new AbortController();
  const armedAt = Date.now();
  // Abort-aware sleep so stop() never has to wait out a pending delay (the
  // failure backoff can reach 10x pollMs, which would stall process exit).
  const sleep = (ms: number) => sleepFor(ms, undefined, { signal: abort.signal }).catch(() => undefined);
  // Terminal invocations already acted on (or predating arming). Bounded by
  // builds per tunnel session (one id string each; never evicted).
  const handled = new Set<string>();
  // Serialize uploads: each ships the daemon's latest record, so a second
  // build finishing mid-upload just refreshes the asset again right after.
  let uploadChain = Promise.resolve();
  let baselined = false;
  let pollFailures = 0;

  const upload = () => {
    uploadChain = uploadChain.then(async () => {
      if (abort.signal.aborted) return;
      try {
        const result = await client.uploadLatestRbeBuild({ assetName, ...(ttl && { ttl }) });
        log(`auto-upload: uploaded ${result.appName} as "${assetName}"`);
      } catch (err) {
        log(`auto-upload: upload failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  };

  const pollLoop = async () => {
    while (!abort.signal.aborted) {
      try {
        const builds = await client.getRecentRbeBuilds();
        pollFailures = 0;
        for (const build of builds) {
          if (!TERMINAL_STATUSES.has(build.status)) continue;
          if (handled.has(build.invocationId)) continue;
          handled.add(build.invocationId);
          if (!baselined && !startedAfter(build, armedAt)) {
            // Terminal at the first successful poll and not provably started
            // after arming: predates this watcher, not ours to upload. The
            // startedAt check keeps a build that started post-arm but finished
            // during an initial poll-failure streak from being misclassified.
            continue;
          }
          if (build.status === 'SUCCEEDED') {
            upload();
          } else {
            log(`auto-upload: build ${build.invocationId} ${build.status}; skipping upload`);
          }
        }
        baselined = true;
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
    // completed build's artifact: give it a bounded grace instead of
    // cancelling it at process exit. The bound must stay well inside
    // `--stop`'s 30s SIGKILL escalation so the tunnel teardown that follows
    // (tunnel.close + stopRbe, only the child runs them) always gets its
    // turn; a slower upload is abandoned, same as any process exit.
    stop: () => {
      abort.abort();
      return Promise.race([uploadChain, sleepFor(10_000, undefined, { ref: false })]).then(() => undefined);
    },
  };
}
