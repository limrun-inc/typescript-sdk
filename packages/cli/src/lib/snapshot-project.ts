import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { XcodeCacheConfig } from '@limrun/api';
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
  try {
    const cwd = fs.realpathSync(projectPath);
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim();
    const root = fs.realpathSync(git(['rev-parse', '--show-toplevel']));
    const repo = repositoryIdentity(git(['remote', 'get-url', 'origin']));
    if (!repo) return undefined;
    const relative = path.relative(root, cwd).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../')) return undefined;
    const key = relative ? `${repo}/${relative}` : repo;
    // Match the API's key bounds. Unrepresentable identities need an explicit key.
    return key.length <= 255 && /^[A-Za-z0-9._+/:@#-]+$/.test(key) ? key : undefined;
  } catch {
    // No Git, no origin, or a local-only repository: leave snapshots explicit.
    return undefined;
  }
}

function repositoryIdentity(remote: string): string | undefined {
  let host: string;
  let repo: string;
  if (remote.includes('://')) {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    host = url.host.toLowerCase();
    repo = url.pathname;
  } else {
    const scp = /^(?:[^/@:\s]+@)?([^/:\s]+):(.+)$/.exec(remote);
    if (!scp || /^[A-Za-z]:[\\/]/.test(remote)) return undefined;
    host = scp[1]!.toLowerCase();
    repo = scp[2]!;
  }
  repo = repo.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!repo || repo.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
  // GitHub repository names are case-insensitive; other hosts may preserve case.
  if (host === 'github.com') repo = repo.toLowerCase();
  return `${host}/${repo}`;
}
