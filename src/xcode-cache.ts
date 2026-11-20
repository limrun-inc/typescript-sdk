import { followPhaseStream } from './internal/instance-phase-stream';

/** @deprecated Use XcodeSnapshotConfig instead. */
export type XcodeCacheConfig = import('./xcode-snapshot').XcodeSnapshotConfig;

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
export async function followXcodeCache(
  target: XcodeCacheFollowTarget,
  options: XcodeCacheFollowOptions = {},
): Promise<XcodeCacheFollowResult> {
  const side = options.side ?? 'restore';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[side];
  let base = target.baseURL;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const result = await followPhaseStream<XcodeInstanceCache>({
    url: `${base}/v1/xcode_instances/${encodeURIComponent(target.instanceId)}/cache`,
    apiKey: target.apiKey,
    instanceId: target.instanceId,
    eventName: 'cache',
    timeoutMs,
    signal: options.signal,
    onOpen: options.onOpen,
    onUpdate: options.onUpdate,
    transitionKey: (cache) =>
      `${cache.restore.phase}/${cache.restore.reason ?? ''}|${cache.save.phase}/${cache.save.reason ?? ''}`,
    isTerminal: (cache) => isCacheTerminal(cache, side),
    goneError: () => new XcodeCacheGoneError(target.instanceId),
    timeoutError: (last) => new XcodeCacheTimeoutError(side, timeoutMs, last),
    unreadableError: (err) => new Error(`Cache stream sent unreadable data: ${err}`),
  });
  return { cache: result.state, gone: result.gone };
}
