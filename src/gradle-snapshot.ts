import { followPhaseStream, type PhaseStreamAuth } from './internal/instance-phase-stream';

/**
 * A disk snapshot of a Gradle build sandbox, restored after the instance is assigned and saved at
 * termination. It keeps the synced project, Gradle's caches and wrapper distributions, ccache and
 * Android SDK packages the build installed.
 */
export type GradleSnapshotConfig = {
  /** Maximum age of the saved archive in seconds, counted from publication. Defaults to 30 days. */
  ttlSeconds?: number;
  /** Save under this organization-scoped key at termination. Defaults to restoring this key too. */
  key?: string;
  /** Restore in order, trying an exact match then the newest literal-prefix match for each entry. */
  restoreKeys?: string[];
};

/**
 * How far a restore got. `disabled` and `skipped` are not failures: they describe an ordinary
 * cold instance, which is perfectly usable. Only `failed` means the workspace was supposed to be
 * warm and something actually broke.
 */
export type GradleSnapshotRestorePhase =
  | 'disabled'
  | 'pending'
  | 'downloading'
  | 'extracting'
  | 'restored'
  | 'skipped'
  | 'failed';

/** How far the save got. */
export type GradleSnapshotSavePhase =
  | 'disabled'
  | 'idle'
  | 'requested'
  | 'quiescing'
  | 'archiving'
  | 'uploading'
  | 'published'
  | 'skipped'
  | 'failed'
  | 'timed_out';

/** A restore key resolution passed over, so a miss is explainable rather than just a miss. */
export type GradleSnapshotSkippedKey = { key: string; reason: string };

export type GradleSnapshotRestoreStatus = {
  phase: GradleSnapshotRestorePhase;
  reason?: string;
  message?: string;
  /** Snapshot key the instance restores from. */
  matchedKey?: string;
  matchKind?: 'exact_hit' | 'prefix_hit';
  skippedKeys?: GradleSnapshotSkippedKey[];
  /** Whether the bytes came through the regional accelerator or directly from object storage. */
  source?: 'tag' | 'direct';
  bytes?: number;
  uncompressedBytes?: number;
  startedAt?: string;
  finishedAt?: string;
};

export type GradleSnapshotSaveStatus = {
  phase: GradleSnapshotSavePhase;
  reason?: string;
  message?: string;
  /** Snapshot key the save publishes under. */
  key?: string;
  bytes?: number;
  uncompressedBytes?: number;
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type GradleInstanceSnapshot = {
  config?: GradleSnapshotConfig;
  restore: GradleSnapshotRestoreStatus;
  save: GradleSnapshotSaveStatus;
};

/** Which half of the snapshot lifecycle a follower waits on. */
export type GradleSnapshotSide = 'restore' | 'save';

export type GradleSnapshotFollowTarget = {
  baseURL: string;
  instanceId: string;
} & PhaseStreamAuth;

export type GradleSnapshotFollowOptions = {
  /** Defaults to 'restore'. */
  side?: GradleSnapshotSide;
  /** Called once per distinct state, including the state the stream opens with. */
  onUpdate?: (snapshot: GradleInstanceSnapshot) => void;
  /**
   * Called when the stream is open, and again after each reconnect. A caller that is about to
   * cause the very transitions it wants to watch waits for this first, so it cannot race its
   * own subscription.
   */
  onOpen?: () => void;
  /**
   * How long to wait for a terminal phase. A restore is bounded at fifteen minutes and a save at
   * ten server-side, so these are generous by design.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type GradleSnapshotFollowResult = {
  /** The last state seen, terminal unless the stream ended first. */
  snapshot: GradleInstanceSnapshot;
  /** True if the instance disappeared before reaching a terminal phase. */
  gone: boolean;
};

/** The instance disappeared before reporting its disk snapshot state. */
export class GradleSnapshotGoneError extends Error {
  constructor(readonly instanceId: string) {
    super(`Instance ${instanceId} was gone before it reported any disk snapshot status`);
    this.name = 'GradleSnapshotGoneError';
  }
}

export class GradleSnapshotTimeoutError extends Error {
  constructor(
    readonly side: GradleSnapshotSide,
    readonly timeoutMs: number,
    readonly snapshot: GradleInstanceSnapshot | undefined,
  ) {
    super(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the disk snapshot ${side} to finish` +
        (snapshot ? ` (last phase: ${snapshot[side].phase})` : ''),
    );
    this.name = 'GradleSnapshotTimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS: Record<GradleSnapshotSide, number> = {
  restore: 20 * 60 * 1000,
  save: 12 * 60 * 1000,
};

/** Phases past which nothing more will happen. */
export function isGradleRestoreTerminal(phase: GradleSnapshotRestorePhase): boolean {
  return phase === 'disabled' || phase === 'restored' || phase === 'skipped' || phase === 'failed';
}

export function isGradleSaveTerminal(phase: GradleSnapshotSavePhase): boolean {
  return (
    phase === 'disabled' ||
    phase === 'published' ||
    phase === 'skipped' ||
    phase === 'failed' ||
    phase === 'timed_out'
  );
}

export function isGradleSnapshotTerminal(
  snapshot: GradleInstanceSnapshot,
  side: GradleSnapshotSide,
): boolean {
  return side === 'restore' ?
      isGradleRestoreTerminal(snapshot.restore.phase)
    : isGradleSaveTerminal(snapshot.save.phase);
}

/** Follow the restore or the save until it ends, the instance disappears, or the wait times out. */
export async function followGradleSnapshot(
  target: GradleSnapshotFollowTarget,
  options: GradleSnapshotFollowOptions = {},
): Promise<GradleSnapshotFollowResult> {
  const side = options.side ?? 'restore';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[side];
  let base = target.baseURL;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const result = await followPhaseStream<GradleInstanceSnapshot>({
    url: `${base}/v1/gradle_instances/${encodeURIComponent(target.instanceId)}/snapshot`,
    auth: target,
    instanceId: target.instanceId,
    eventName: 'snapshot',
    timeoutMs,
    signal: options.signal,
    onOpen: options.onOpen,
    onUpdate: options.onUpdate,
    transitionKey: (snapshot) =>
      `${snapshot.restore.phase}/${snapshot.restore.reason ?? ''}|${snapshot.save.phase}/${
        snapshot.save.reason ?? ''
      }`,
    isTerminal: (snapshot) => isGradleSnapshotTerminal(snapshot, side),
    goneError: () => new GradleSnapshotGoneError(target.instanceId),
    timeoutError: (last) => new GradleSnapshotTimeoutError(side, timeoutMs, last),
    unreadableError: (err) => new Error(`Disk snapshot stream sent unreadable data: ${err}`),
  });
  return { snapshot: result.state, gone: result.gone };
}
