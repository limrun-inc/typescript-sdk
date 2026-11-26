import { projectIdentity, type XcodeCacheConfig } from '@limrun/api';
import { type CacheFlags, parseSnapshotConfig } from './cache';

/** Explicit settings keep their semantics, including restore-only snapshots. */
export function projectSnapshotConfig(flags: CacheFlags, projectPath: string): XcodeCacheConfig | undefined {
  const explicit = parseSnapshotConfig(flags);
  if (explicit || flags['no-snapshot']) return explicit;
  const key = projectSnapshotKey(projectPath);
  return key ? { key } : undefined;
}

/** Share snapshots across clones and worktrees without including local paths or credentials. */
export function projectSnapshotKey(projectPath: string): string | undefined {
  const project = projectIdentity(projectPath);
  if (!project) return undefined;
  const key = project.directory ? `${project.repository}/${project.directory}` : project.repository;
  // Match the API's key bounds. Unrepresentable identities need an explicit key.
  return key.length <= 255 && /^[A-Za-z0-9._+/:@#-]+$/.test(key) ? key : undefined;
}
