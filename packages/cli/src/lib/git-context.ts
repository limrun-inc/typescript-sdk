import { execFileSync } from 'child_process';
import type { GitBuildContext } from '@limrun/api';

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * Best-effort checkout state for the sync root, sent with prepare builds so
 * the daemon can export GIT_COMMIT/GIT_BRANCH/GIT_DIRTY (sync never uploads
 * .git). Returns undefined outside a git checkout.
 */
export function readGitContext(syncRoot: string): GitBuildContext | undefined {
  const commit = git(syncRoot, ['rev-parse', 'HEAD']);
  if (!commit) {
    return undefined;
  }
  const context: GitBuildContext = { commit };
  const branch = git(syncRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD') {
    context.branch = branch;
  }
  const status = git(syncRoot, ['status', '--porcelain']);
  if (status !== undefined) {
    context.dirty = status !== '';
  }
  return context;
}
