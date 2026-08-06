import { createEventSource, type EventSourceMessage } from 'eventsource-client';

import { nodeProxyTransport } from './internal/proxy-transport';

/**
 * Build cache configuration for an Xcode instance. Omitted means an ordinary uncached
 * instance, which resolves nothing, adopts no stable directory, and publishes nothing.
 */
export type XcodeCacheConfig = {
  /**
   * Where this instance's workspace is published at termination. Organization-scoped and set
   * once, either here or later through `bindCacheKey`. Reusing a key is normal operation:
   * termination replaces its archive.
   *
   * With no restoreKeys, a key given here also serves as the single restore key.
   */
  key?: string;
  /**
   * Keys to restore from, tried in exactly this order: exact match first, then literal prefix,
   * newest archive first within a prefix. Immutable after create.
   */
  restoreKeys?: string[];
  /**
   * Project-root-relative paths to store. Create-only, and it controls what is STORED: the
   * first publication under a key fixes its path set and restores materialize that set.
   * Omitted means the whole deterministic workspace.
   */
  paths?: string[];
};

/**
 * How far a restore got. `disabled`, `unsupported` and `skipped` are not failures: they
 * describe an ordinary cold instance, which is perfectly usable. Only `failed` means the
 * workspace was supposed to be warm and something actually broke.
 */
export type XcodeCacheRestorePhase =
  | 'disabled'
  | 'unsupported'
  | 'placing'
  | 'downloading'
  | 'materializing'
  | 'restored'
  | 'skipped'
  | 'failed';

/** How far publication got. */
export type XcodeCacheSavePhase =
  | 'disabled'
  | 'idle'
  | 'quiescing'
  | 'archiving'
  | 'uploading'
  | 'verifying'
  | 'published'
  | 'skipped'
  | 'failed'
  | 'timed_out';

/** A restore key resolution passed over, so a miss is explainable rather than just a miss. */
export type XcodeCacheSkippedKey = { key: string; reason: string };

export type XcodeCacheRestoreStatus = {
  phase: XcodeCacheRestorePhase;
  reason?: string;
  message?: string;
  /** Restore key whose archive was used. */
  matchedKey?: string;
  matchKind?: 'exact_hit' | 'prefix_hit';
  skippedKeys?: XcodeCacheSkippedKey[];
  /** Path set actually materialized, which is the set the archive stores. */
  paths?: string[];
  /** Whether the bytes came through the regional accelerator or direct from object storage. */
  source?: 'tag' | 'tigris';
  bytes?: number;
  uncompressedBytes?: number;
  startedAt?: string;
  finishedAt?: string;
};

export type XcodeCacheSaveStatus = {
  phase: XcodeCacheSavePhase;
  reason?: string;
  message?: string;
  /** Destination key the archive is published under. */
  cacheKey?: string;
  paths?: string[];
  bytes?: number;
  uncompressedBytes?: number;
  startedAt?: string;
  finishedAt?: string;
};

export type XcodeInstanceCache = {
  config?: XcodeCacheConfig;
  restore: XcodeCacheRestoreStatus;
  save: XcodeCacheSaveStatus;
};

/** Which half of the cache lifecycle a follower waits on. */
export type XcodeCacheSide = 'restore' | 'save';

export type XcodeCacheFollowOptions = {
  /** Defaults to 'restore'. */
  side?: XcodeCacheSide;
  /**
   * Called once per distinct state, including the snapshot the stream opens with. Phases that
   * repeat, which a reconnect produces, are not reported again.
   */
  onUpdate?: (cache: XcodeInstanceCache) => void;
  /**
   * Called when the stream is open, and again after each reconnect. A caller that is about to
   * cause the very transitions it wants to watch waits for this first, so it cannot race its
   * own subscription.
   */
  onOpen?: () => void;
  /**
   * How long to wait for a terminal phase. Restores move multi-gigabyte archives and
   * publication is capped server-side at ten minutes, so these are generous by design.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type XcodeCacheFollowResult = {
  /** The last state seen, terminal unless the stream ended first. */
  cache: XcodeInstanceCache;
  /**
   * True when the instance was collected before the phase went terminal. The last snapshot is
   * still the summary: the control plane writes the terminal phase and deletes moments later.
   */
  gone: boolean;
};

/**
 * The instance was gone before it said anything about its cache, so there is no last state to
 * summarise. Distinct from a follow that ends with `gone: true`, which at least saw one.
 */
export class XcodeCacheGoneError extends Error {
  constructor(readonly instanceId: string) {
    super(`Instance ${instanceId} was gone before it reported any cache status`);
    this.name = 'XcodeCacheGoneError';
  }
}

export class XcodeCacheTimeoutError extends Error {
  constructor(
    readonly side: XcodeCacheSide,
    readonly timeoutMs: number,
    readonly cache: XcodeInstanceCache | undefined,
  ) {
    super(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the cache ${side} to finish` +
        (cache ? ` (last phase: ${cache[side].phase})` : ''),
    );
    this.name = 'XcodeCacheTimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS: Record<XcodeCacheSide, number> = {
  restore: 20 * 60 * 1000,
  save: 12 * 60 * 1000,
};

/** Phases past which nothing more will happen. */
export function isRestoreTerminal(phase: XcodeCacheRestorePhase): boolean {
  return (
    phase === 'disabled' ||
    phase === 'unsupported' ||
    phase === 'restored' ||
    phase === 'skipped' ||
    phase === 'failed'
  );
}

/**
 * Separates the one outcome worth reacting to from the terminal phases that just mean "cold,
 * carry on". A caller that created an instance for a warm workspace deletes it on a failure,
 * but a fallback to a cold build leaves a perfectly usable instance behind.
 */
export function isRestoreFailure(phase: XcodeCacheRestorePhase): boolean {
  return phase === 'failed';
}

export function isSaveTerminal(phase: XcodeCacheSavePhase): boolean {
  return (
    phase === 'disabled' ||
    phase === 'published' ||
    phase === 'skipped' ||
    phase === 'failed' ||
    phase === 'timed_out'
  );
}

export function isCacheTerminal(cache: XcodeInstanceCache, side: XcodeCacheSide): boolean {
  return side === 'restore' ? isRestoreTerminal(cache.restore.phase) : isSaveTerminal(cache.save.phase);
}

export type XcodeCacheFollowTarget = {
  baseURL: string;
  apiKey: string;
  instanceId: string;
};

/**
 * Follows an instance's cache status until the chosen side reaches a terminal phase, the
 * instance is collected, or the wait times out.
 *
 * The transport is the same endpoint that serves a JSON snapshot, asked for as an event
 * stream. The server emits on phase change only, so every callback is a real transition.
 */
export function followXcodeCache(
  target: XcodeCacheFollowTarget,
  options: XcodeCacheFollowOptions = {},
): Promise<XcodeCacheFollowResult> {
  const side = options.side ?? 'restore';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[side];
  let base = target.baseURL;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const url = `${base}/v1/xcode_instances/${encodeURIComponent(target.instanceId)}/cache`;

  return new Promise<XcodeCacheFollowResult>((resolve, reject) => {
    let last: XcodeInstanceCache | undefined;
    let lastKey = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        source.close();
      } catch {
        // A stream that never opened has nothing to close.
      }
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new XcodeCacheTimeoutError(side, timeoutMs, last))),
      timeoutMs,
    );
    const onAbort = () => finish(() => reject(options.signal?.reason ?? new Error('aborted')));

    let confirming = false;
    const confirmGone = () => {
      if (confirming || settled) return;
      confirming = true;
      nodeProxyTransport
        .fetch(url, {
          headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' },
        })
        .then(async (res) => {
          confirming = false;
          if (res.status !== 404) {
            await res.text().catch(() => undefined);
            return;
          }
          finish(() =>
            last ? resolve({ cache: last, gone: true }) : reject(new XcodeCacheGoneError(target.instanceId)),
          );
        })
        .catch(() => {
          confirming = false;
        });
    };

    // The endpoint answers from the region, which keeps the instance while it terminates and
    // drops it once it is collected, so a 404 is the instance being over rather than a fault.
    // Without this the client treats it as a connection to retry and follows a gone instance
    // until the timeout, which is minutes of a command that looks hung and says nothing.
    const fetchOrGone: typeof nodeProxyTransport.fetch = async (input, init) => {
      const res = await nodeProxyTransport.fetch(input, init);
      if (res.status === 404) {
        finish(() =>
          last ? resolve({ cache: last, gone: true }) : reject(new XcodeCacheGoneError(target.instanceId)),
        );
      }
      return res;
    };

    const source = createEventSource({
      url,
      fetch: fetchOrGone,
      onConnect: () => options.onOpen?.(),
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        Accept: 'text/event-stream',
      },
      onMessage: (message: EventSourceMessage) => {
        if (message.event !== 'cache' && message.event !== 'gone') return;
        let cache: XcodeInstanceCache;
        try {
          cache = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
        } catch (err) {
          finish(() => reject(new Error(`Cache stream sent unreadable data: ${err}`)));
          return;
        }
        last = cache;
        if (message.event === 'gone') {
          // The server also ends the stream this way when its own watch is cut short, which
          // Kubernetes does routinely on a long one, so a snapshot decides which it was. The
          // client library reconnects on its own when the instance is in fact still there.
          confirmGone();
          return;
        }
        // A reconnect replays the current state, which is not a transition.
        const key = `${cache.restore.phase}/${cache.restore.reason ?? ''}|${cache.save.phase}/${
          cache.save.reason ?? ''
        }`;
        if (key !== lastKey) {
          lastKey = key;
          options.onUpdate?.(cache);
        }
        if (isCacheTerminal(cache, side)) {
          finish(() => resolve({ cache, gone: false }));
        }
      },
    });

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
