import {
  followXcodeCache,
  isRestoreTerminal,
  isSaveTerminal,
  XcodeCacheGoneError,
  XcodeCacheTimeoutError,
  type XcodeCacheFollowOptions,
  type XcodeCacheFollowTarget,
  type XcodeCacheRestorePhase,
  type XcodeCacheRestoreStatus,
  type XcodeCacheSavePhase,
  type XcodeCacheSaveStatus,
  type XcodeCacheSide,
  type XcodeCacheSkippedKey,
  type XcodeInstanceCache,
} from './xcode-cache';

/** A saved Xcode workspace to restore at creation and publish at termination. */
export type XcodeSnapshotConfig = {
  /** Save under this organization-scoped key at termination. Defaults to restoring this key too. */
  key?: string;
  /** Restore in order, trying an exact match then the newest literal-prefix match for each entry. */
  restoreKeys?: string[];
  /** Paths to save, fixed at creation. Omit to preserve the whole workspace. */
  paths?: string[];
};
export type XcodeSnapshotRestorePhase = XcodeCacheRestorePhase;
export type XcodeSnapshotSavePhase = XcodeCacheSavePhase;
export type XcodeSnapshotRestoreStatus = XcodeCacheRestoreStatus;
export type XcodeSnapshotSkippedKey = XcodeCacheSkippedKey;
export type XcodeSnapshotSide = XcodeCacheSide;
export type XcodeSnapshotFollowTarget = XcodeCacheFollowTarget;

export type XcodeSnapshotSaveStatus = Omit<XcodeCacheSaveStatus, 'cacheKey'> & {
  /** Destination key the workspace is published under. */
  snapshotKey?: string;
};

export type XcodeInstanceSnapshot = {
  config?: XcodeSnapshotConfig;
  restore: XcodeSnapshotRestoreStatus;
  save: XcodeSnapshotSaveStatus;
};

export type XcodeSnapshotFollowOptions = Omit<XcodeCacheFollowOptions, 'onUpdate'> & {
  /** Called once per distinct state, including the initial state. */
  onUpdate?: (snapshot: XcodeInstanceSnapshot) => void;
};

export type XcodeSnapshotFollowResult = {
  snapshot: XcodeInstanceSnapshot;
  /** True if the instance disappeared before reaching a terminal phase. */
  gone: boolean;
};

/** The instance disappeared before reporting its snapshot state. */
export class XcodeSnapshotGoneError extends XcodeCacheGoneError {
  constructor(instanceId: string) {
    super(instanceId);
    this.name = 'XcodeSnapshotGoneError';
    this.message = `Instance ${instanceId} was gone before it reported any snapshot status`;
  }
}

export class XcodeSnapshotTimeoutError extends XcodeCacheTimeoutError {
  readonly snapshot: XcodeInstanceSnapshot | undefined;

  constructor(error: XcodeCacheTimeoutError) {
    super(error.side, error.timeoutMs, error.cache);
    this.name = 'XcodeSnapshotTimeoutError';
    this.message = error.message.replace('the cache ', 'the snapshot ');
    this.snapshot = error.cache ? snapshotFromCache(error.cache) : undefined;
  }
}

// Keep the wire format stable so new clients can use existing servers and saved workspaces.
export function snapshotFromCache(cache: XcodeInstanceCache): XcodeInstanceSnapshot {
  const { cacheKey, ...save } = cache.save;
  return {
    ...cache,
    save: { ...save, ...(cacheKey !== undefined ? { snapshotKey: cacheKey } : {}) },
  };
}

export function isSnapshotTerminal(snapshot: XcodeInstanceSnapshot, side: XcodeSnapshotSide): boolean {
  return side === 'restore' ? isRestoreTerminal(snapshot.restore.phase) : isSaveTerminal(snapshot.save.phase);
}

/** Follow restoration or publication until it ends, the instance disappears, or the wait times out. */
export async function followXcodeSnapshot(
  target: XcodeSnapshotFollowTarget,
  options: XcodeSnapshotFollowOptions = {},
): Promise<XcodeSnapshotFollowResult> {
  const { onUpdate, ...rest } = options;
  try {
    const result = await followXcodeCache(target, {
      ...rest,
      ...(onUpdate ? { onUpdate: (cache: XcodeInstanceCache) => onUpdate(snapshotFromCache(cache)) } : {}),
    });
    return { snapshot: snapshotFromCache(result.cache), gone: result.gone };
  } catch (error) {
    if (error instanceof XcodeCacheGoneError) throw new XcodeSnapshotGoneError(error.instanceId);
    if (error instanceof XcodeCacheTimeoutError) throw new XcodeSnapshotTimeoutError(error);
    throw error;
  }
}
