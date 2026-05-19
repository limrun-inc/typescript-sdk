// Driver that fetches accessibility snapshots over an existing WebSocket and
// emits change-detected updates to subscribers. Reuses the RemoteControl's
// signaling WS (not a separate connection) and routes responses by request id.
//
// Cadence:
// - Base interval (default 500ms) right after a fetch resolved.
// - Doubles up to maxBackoff (default 2000ms) while consecutive snapshots
//   are byte-identical.
// - Jumps to UNAVAILABLE_RETRY_INTERVAL_MS when the server reports the AX
//   subsystem isn't usable yet.
// - On bumpActivity() (called by RemoteControl after any user input), the
//   backoff is reset to base — UI almost certainly changed.

import {
  AX_UNAVAILABLE_ERROR,
  AxPlatform,
  AxSnapshot,
  axSnapshotsEqual,
  normalizeAndroidTree,
  normalizeIosTree,
} from './ax-tree';

const DEFAULT_BASE_INTERVAL_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 2000;
const UNAVAILABLE_RETRY_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
// After a user-driven event (tap/scroll/openUrl/etc.) we enter a brief
// "boost" window during which scheduled fetches happen on a shorter
// interval. This catches mid- and post-animation UI states without
// hammering the server during idle time.
const ACTIVITY_BOOST_DURATION_MS = 1200;
const ACTIVITY_BOOST_INTERVAL_MS = 250;

// Coarse-grained status surfaced to customers so they can render readiness
// indicators / error UI in their own panels.
//
// State machine:
//   idle ───start()───▶ starting ──snapshot────▶ ready
//                                ──AX_UNAVAILABLE_ERROR─▶ unavailable
//                                ──other error──▶ error
//   ready ──AX_UNAVAILABLE_ERROR─▶ unavailable
//        ──other error──▶ error (transient; back to ready on next success)
//   unavailable ──snapshot────▶ ready
//   error       ──snapshot────▶ ready
//   * stop() ────────▶ idle
//
// Note `error` is sticky-but-recoverable: the fetcher keeps polling, and as
// soon as a fresh snapshot arrives we transition back to `ready`. Customers
// don't need to manually retry.
export type AxStatus = 'idle' | 'starting' | 'ready' | 'unavailable' | 'error';

export type AxFetcherSendFn = (payload: Record<string, unknown>) => boolean;

export interface AxFetcherOptions {
  platform: AxPlatform;
  send: AxFetcherSendFn;
  onSnapshot: (snapshot: AxSnapshot | null) => void;
  // Optional: notified on every status transition (deduplicated — no
  // self-loops are emitted). `error` provides the error message when the
  // status is `error` or `unavailable`.
  onStatusChange?: (status: AxStatus, error?: string) => void;
  baseIntervalMs?: number;
  maxBackoffMs?: number;
}

type PendingResolver = {
  resolve: (snapshot: AxSnapshot) => void;
  reject: (err: Error) => void;
  timer: number;
};

// Returns the request id used so the caller can route the matching response
// back. We use ax-rc-{ts}-{rand} so it's easy to distinguish from screenshot
// ids in debug output.
const generateRequestId = (): string => `ax-rc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export class AxFetcher {
  private readonly platform: AxPlatform;
  private readonly send: AxFetcherSendFn;
  private readonly onSnapshot: (snapshot: AxSnapshot | null) => void;
  private readonly onStatusChange?: (status: AxStatus, error?: string) => void;
  private readonly baseIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly pending: Map<string, PendingResolver> = new Map();

  private running = false;
  private timer: number | undefined;
  private currentInterval: number;
  private lastSnapshot: AxSnapshot | null = null;
  // Single-flight: only one outstanding request at a time. Avoids piling
  // identical requests on a slow server.
  private inflight = false;
  // Rate-limit floor for bumpActivity so high-frequency input (drags,
  // typing) doesn't trigger a request storm.
  private lastBumpAtMs = 0;
  // Wall-clock timestamp until which we're in "activity boost" mode and
  // schedule fetches at ACTIVITY_BOOST_INTERVAL_MS instead of the normal
  // backed-off interval. Set by bumpActivity().
  private boostUntilMs = 0;
  // Coarse-grained current status; deduplicated before emission so
  // identical-to-current transitions are no-ops.
  private status: AxStatus = 'idle';

  constructor(opts: AxFetcherOptions) {
    this.platform = opts.platform;
    this.send = opts.send;
    this.onSnapshot = opts.onSnapshot;
    this.onStatusChange = opts.onStatusChange;
    this.baseIntervalMs = opts.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.currentInterval = this.baseIntervalMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.currentInterval = this.baseIntervalMs;
    this.boostUntilMs = 0;
    this.setStatus('starting');
    // Kick a fetch immediately on enable so the overlay shows up fast.
    void this.runOnce();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.failAllPending('Inspector stopped');
    this.lastSnapshot = null;
    this.setStatus('idle');
    this.onSnapshot(null);
  }

  getStatus(): AxStatus {
    return this.status;
  }

  private setStatus(next: AxStatus, error?: string): void {
    if (this.status === next) return;
    this.status = next;
    if (!this.onStatusChange) return;
    try {
      this.onStatusChange(next, error);
    } catch (err) {
      // Don't let customer status-handler errors break our state machine.
      console.error('[AxFetcher] onStatusChange threw:', err);
    }
  }

  // Called after any user-driven action that's likely to change the UI
  // (taps, scrolls, key events, openUrl, app termination, orientation
  // change, etc.). Has two effects:
  //
  //   1. Resets the polling interval to base and triggers an immediate
  //      fetch (rate-limited so drags / rapid typing don't request-storm).
  //   2. Enters a brief "boost" window during which scheduleNext() uses a
  //      shorter interval (ACTIVITY_BOOST_INTERVAL_MS), so we capture the
  //      mid- and post-animation tree without waiting for the next
  //      back-off cycle.
  bumpActivity(): void {
    if (!this.running) return;
    const now = Date.now();
    // Extend the boost window on every bump so a rapid sequence of inputs
    // (a swipe-then-tap, scrolling through a list) keeps polling fast
    // throughout the action.
    this.boostUntilMs = now + ACTIVITY_BOOST_DURATION_MS;
    const floorMs = Math.max(150, Math.floor(this.baseIntervalMs / 2));
    if (now - this.lastBumpAtMs < floorMs) {
      // Still reset cadence so the next scheduled fetch lands at base
      // interval, but don't cancel the current timer or trigger an extra
      // immediate fetch.
      this.currentInterval = this.baseIntervalMs;
      return;
    }
    this.lastBumpAtMs = now;
    this.currentInterval = this.baseIntervalMs;
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.inflight) {
      void this.runOnce();
    }
  }

  // Fire a one-shot fetch independent of the poll loop. Useful for the
  // imperative refresh() ref method customers may call.
  //
  // Goes through the same change-detect path as the regular poll loop —
  // identical-to-last-snapshot responses do NOT re-emit via onSnapshot, so
  // a customer calling refresh() in a tight loop doesn't see a stream of
  // duplicate snapshots. The returned promise still resolves with the
  // (possibly identical) snapshot for the caller's own use.
  async refresh(): Promise<AxSnapshot> {
    const next = await this.requestOnce();
    if (this.running) {
      this.deliver(next);
    }
    return next;
  }

  // Returns the latest snapshot delivered to onSnapshot. May be stale.
  getLatest(): AxSnapshot | null {
    return this.lastSnapshot;
  }

  // Called by RemoteControl's ws.onmessage when it sees a message type we own.
  // Returns true when the message was a response we were waiting for.
  handleMessage(message: { type?: string; id?: string; [k: string]: unknown }): boolean {
    if (!message || typeof message.id !== 'string') return false;
    const id = message.id;
    const resolver = this.pending.get(id);
    if (!resolver) return false;

    if (this.platform === 'ios') {
      // iOS: {type:'elementTreeResult', id, json, error}
      if (message.type !== 'elementTreeResult') return false;
      const error = typeof message.error === 'string' ? message.error : null;
      if (error) {
        this.settleReject(id, new Error(error));
        return true;
      }
      const json = typeof message.json === 'string' ? message.json : '';
      try {
        const parsed = JSON.parse(json);
        const snapshot = normalizeIosTree(parsed);
        this.settleResolve(id, snapshot);
      } catch (e) {
        this.settleReject(id, e instanceof Error ? e : new Error(String(e)));
      }
      return true;
    }

    // android: {type:'getElementTreeResult', id, payload:{xml,nodes}, error?}
    if (message.type !== 'getElementTreeResult') return false;
    const errObj = message.error as { message?: string; code?: string } | undefined;
    if (errObj && typeof errObj === 'object') {
      const msg = typeof errObj.message === 'string' ? errObj.message : 'getElementTree failed';
      this.settleReject(id, new Error(msg));
      return true;
    }
    const payload = message.payload as { nodes?: unknown[] } | undefined;
    const nodes = Array.isArray(payload?.nodes) ? (payload!.nodes as Record<string, unknown>[]) : [];
    try {
      const snapshot = normalizeAndroidTree(nodes as Parameters<typeof normalizeAndroidTree>[0]);
      this.settleResolve(id, snapshot);
    } catch (e) {
      this.settleReject(id, e instanceof Error ? e : new Error(String(e)));
    }
    return true;
  }

  private buildRequest(id: string): Record<string, unknown> {
    if (this.platform === 'ios') {
      return { type: 'elementTree', id };
    }
    return { type: 'getElementTree', id };
  }

  private async requestOnce(): Promise<AxSnapshot> {
    const id = generateRequestId();
    return new Promise<AxSnapshot>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('elementTree request timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const ok = this.send(this.buildRequest(id));
      if (!ok) {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('elementTree send failed (WebSocket not open)'));
      }
    });
  }

  private async runOnce(): Promise<void> {
    if (!this.running) return;
    if (this.inflight) return;
    this.inflight = true;
    try {
      const next = await this.requestOnce();
      if (!this.running) return;
      this.deliver(next);
    } catch (err) {
      // Don't surface transient errors to the customer's onSnapshot — just
      // back off and try again. We DO surface them via status transitions
      // so customers building their own UI can show a banner / spinner /
      // etc. Persistent failures eventually settle on the longest backoff.
      //
      // If the fetcher was stopped while a request was in flight, the
      // pending request is rejected by failAllPending() and we end up here
      // with running=false. In that case skip the status transition — the
      // current status is already 'idle' and we shouldn't churn it back to
      // an error.
      if (!this.running) return;
      const message = err instanceof Error ? err.message : String(err);
      const unavailable = /unavailable|not (yet )?running|failed|timeout/i.test(message);
      this.currentInterval =
        unavailable ? UNAVAILABLE_RETRY_INTERVAL_MS : Math.min(this.currentInterval * 2, this.maxBackoffMs);
      this.setStatus(unavailable ? 'unavailable' : 'error', message);
    } finally {
      this.inflight = false;
      this.scheduleNext();
    }
  }

  private deliver(next: AxSnapshot): void {
    const previous = this.lastSnapshot;
    if (axSnapshotsEqual(previous, next)) {
      // Same payload — back off so we don't churn.
      this.currentInterval = Math.min(this.currentInterval * 2, this.maxBackoffMs);
      // Still update capturedAt by replacing the cached snapshot.
      this.lastSnapshot = next;
      // A successful (even if unchanged) fetch is a sign that AX is
      // working — emit `ready` if we were in a degraded status.
      if (!next.errors?.includes(AX_UNAVAILABLE_ERROR)) {
        this.setStatus('ready');
      }
      return;
    }
    this.lastSnapshot = next;
    this.currentInterval = this.baseIntervalMs;
    if (next.errors?.includes(AX_UNAVAILABLE_ERROR)) {
      this.currentInterval = UNAVAILABLE_RETRY_INTERVAL_MS;
      this.setStatus('unavailable', AX_UNAVAILABLE_ERROR);
    } else {
      this.setStatus('ready');
    }
    this.onSnapshot(next);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
    }
    // While in activity-boost mode, cap the wait so we keep capturing the
    // UI through any animation that's mid-flight. Outside the boost
    // window, use the normal (possibly backed-off) interval.
    const interval =
      Date.now() < this.boostUntilMs ?
        Math.min(ACTIVITY_BOOST_INTERVAL_MS, this.currentInterval)
      : this.currentInterval;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.runOnce();
    }, interval);
  }

  private settleResolve(id: string, snapshot: AxSnapshot): void {
    const r = this.pending.get(id);
    if (!r) return;
    window.clearTimeout(r.timer);
    this.pending.delete(id);
    r.resolve(snapshot);
  }

  private settleReject(id: string, err: Error): void {
    const r = this.pending.get(id);
    if (!r) return;
    window.clearTimeout(r.timer);
    this.pending.delete(id);
    r.reject(err);
  }

  private failAllPending(reason: string): void {
    for (const [id, r] of this.pending.entries()) {
      window.clearTimeout(r.timer);
      r.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
