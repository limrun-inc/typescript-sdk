import {
  followInstanceSnapshot,
  type GradleInstanceSnapshot,
  type GradleSnapshotConfig,
  type GradleSnapshotFollowOptions,
  type GradleSnapshotFollowResult,
  type GradleSnapshotFollowTarget,
} from './gradle-snapshot';

/**
 * A disk snapshot of a macOS instance, restored after the instance is assigned and saved at
 * termination. It keeps the files the guest changed since the instance started: the user's home,
 * installed apps and tools. It restores only onto an instance with the same macOS build.
 */
export type MacosSnapshotConfig = GradleSnapshotConfig;

/** The disk snapshot configuration and the state of its restore and save. */
export type MacosInstanceSnapshot = GradleInstanceSnapshot;

export type MacosSnapshotFollowOptions = GradleSnapshotFollowOptions;
export type MacosSnapshotFollowResult = GradleSnapshotFollowResult;

/** Follow the restore or the save until it ends, the instance disappears, or the wait times out. */
export function followMacosSnapshot(
  target: GradleSnapshotFollowTarget,
  options: MacosSnapshotFollowOptions = {},
): Promise<MacosSnapshotFollowResult> {
  return followInstanceSnapshot('macos_instances', target, options);
}
