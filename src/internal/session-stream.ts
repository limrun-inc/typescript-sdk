/**
 * Long-lived tail of a runtime session SSE stream (live app logs, the
 * coalesced event log, or iOS app performance samples). The runtime replays
 * its buffer on first connect and tags every entry with a monotonic SSE id;
 * eventsource-client sends Last-Event-ID on reconnect, so the runtime resumes
 * exactly where the stream broke and each entry is delivered exactly once,
 * as long as the entries are still in the runtime's buffer.
 *
 * Stream health follows the exec client's model (and reuses its policy): the
 * EventSource reconnects forever on its own, so a dead stream (deleted
 * instance) would otherwise retry silently for good. Proof of life — a
 * delivered entry, a keepalive comment, or a clean connection that stays
 * open healthyConnectionMs — resets the give-up clock; once the stream stays
 * broken past giveUpAfterMs, onError fires once and the stream closes. A
 * 404 closes it at once: the router answers it for a missing or terminating
 * instance, and a runtime answers it for a stream it does not serve.
 */

import { createEventSource, type EventSourceMessage } from 'eventsource-client';
import { sseStreamPolicy } from '../exec-client';
import { nodeProxyTransport } from './proxy-transport';
import { sseFetch } from './sse-fetch';
import type { Fetch } from './builtin-types';

/** The session stream kept failing past the give-up window; it has been closed. */
export class SessionStreamLostError extends Error {}

/**
 * The session stream answered 404 and has been closed: the instance is gone or terminating,
 * or its runtime predates the stream.
 */
export class SessionStreamNotFoundError extends SessionStreamLostError {}

/** The SSE event the iOS runtime sends after replaying its buffer. */
const REPLAYED_EVENT = 'replayed';

export interface SessionStreamOptions<T extends { ts: number }> {
  /** Full URL of the runtime SSE endpoint, without credentials. */
  url: string;
  /** Instance token; sent as a bearer Authorization header. */
  token: string;
  /** Called once per delivered entry, in stream order. */
  onEntry: (entry: T) => void;
  /**
   * Called when the runtime has replayed its buffer, so later entries are live. Android and
   * older iOS runtimes never call it.
   */
  onReplayed?: (() => void) | undefined;
  /** Called at most once, when the stream is given up on and closed. */
  onError?: ((error: Error) => void) | undefined;
}

/**
 * Connects to a session SSE endpoint and delivers parsed entries until the
 * returned function is called (or the stream is given up on). Entries are
 * one JSON object per SSE data frame; frames that do not parse to an object
 * with a numeric `ts` are skipped.
 */
export function streamSessionEntries<T extends { ts: number }>(options: SessionStreamOptions<T>): () => void {
  let closed = false;
  let connectedAt = 0;
  let deadSince = 0;
  let lastCycleAt = 0;
  let lastCycleMono = 0;
  let proofOfLifeThisCycle = false;
  let cleanResponseThisCycle = false;
  let lastStreamError: Error | undefined;
  let notFound = false;

  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    eventSource.close();
    options.onError?.(error);
  };

  // Stream health is judged at the fetch surface, where the response status
  // is visible; the library fires onConnect for error responses too, so an
  // error page held open must not read as a healthy connection. A rejected
  // fetch never reaches onDisconnect (the hazard sseFetch exists for):
  // capture it for the give-up message and let the clock decide, so one
  // transient refusal does not kill a live stream.
  const fetchWithStreamPolicy: Fetch = async (input, init) => {
    const response = await nodeProxyTransport.fetch(input, init);
    if (!response.ok) {
      lastStreamError = new Error(`server answered HTTP ${response.status}`);
    }
    notFound = response.status === 404;
    cleanResponseThisCycle = response.ok;
    return response;
  };

  const eventSource = createEventSource({
    url: options.url,
    fetch: sseFetch(fetchWithStreamPolicy, (err) => {
      lastStreamError = err instanceof Error ? err : new Error(String(err));
    }),
    headers: { Authorization: `Bearer ${options.token}` },
    onConnect: () => {
      connectedAt = Date.now();
    },
    // Keepalive comments count as proof of life (onMessage never sees them).
    onComment: () => {
      proofOfLifeThisCycle = true;
    },
    // Fires once per broken cycle, before the retry timer is armed, on both
    // failure paths (request rejected, stream ended). This is where the
    // give-up clock runs.
    onScheduleReconnect: () => {
      if (closed) return;
      if (notFound) {
        fail(
          new SessionStreamNotFoundError(
            `session stream to ${options.url} answered HTTP 404: the instance no longer exists, ` +
              'or its runtime does not serve this stream',
          ),
        );
        return;
      }
      const now = Date.now();
      const mono = performance.now();
      const livedMs = connectedAt > 0 ? now - connectedAt : 0;
      connectedAt = 0;
      // Date.now() is wall clock: a laptop waking from sleep (or a clock
      // step) would arrive with the whole window already "elapsed" and fail
      // on its first attempt. Sleep is the wall clock advancing while the
      // monotonic clock stands still; a large drift between the two restarts
      // the streak.
      if (deadSince > 0 && lastCycleAt > 0) {
        const wallGapMs = now - lastCycleAt;
        const monoGapMs = mono - lastCycleMono;
        if (wallGapMs - monoGapMs > 30_000) {
          deadSince = now;
        }
      }
      lastCycleAt = now;
      lastCycleMono = mono;
      const healthy =
        proofOfLifeThisCycle || (cleanResponseThisCycle && livedMs >= sseStreamPolicy.healthyConnectionMs);
      proofOfLifeThisCycle = false;
      cleanResponseThisCycle = false;
      if (healthy) {
        deadSince = 0;
        lastStreamError = undefined;
        return;
      }
      if (deadSince === 0) {
        deadSince = now;
        return;
      }
      if (now - deadSince >= sseStreamPolicy.giveUpAfterMs) {
        const seconds = Math.round((now - deadSince) / 1000);
        const cause = lastStreamError ? `; last error: ${lastStreamError.message}` : '';
        fail(
          new SessionStreamLostError(
            `session stream to ${options.url} kept failing for ${seconds}s without delivering entries${cause}; ` +
              'the instance may no longer exist',
          ),
        );
      }
    },
    onMessage: (message: EventSourceMessage) => {
      deadSince = 0;
      proofOfLifeThisCycle = true;
      lastStreamError = undefined;
      if (message.event === REPLAYED_EVENT) {
        options.onReplayed?.();
        return;
      }
      const data = typeof message.data === 'string' ? message.data : String(message.data ?? '');
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof (parsed as { ts?: unknown })?.ts !== 'number') {
        return;
      }
      options.onEntry(parsed as T);
    },
  });

  return () => {
    if (closed) return;
    closed = true;
    eventSource.close();
  };
}
