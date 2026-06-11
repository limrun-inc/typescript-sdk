import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * A "scope" isolates the most-recently-used instance per context so parallel AI
 * agents can each drive their own instance instead of sharing one global slot.
 *
 * Hybrid model:
 *   - Inside a *linked* git worktree (one created via `git worktree add`), the
 *     scope is that worktree's root, so each worktree gets its own instance.
 *   - Everywhere else (a repo's main checkout, a plain directory, or outside a
 *     repo) the scope is a single shared GLOBAL slot, preserving the original
 *     "use the most recent instance I created" behavior with zero setup.
 *
 * Resolution order (first match wins), memoized for the process lifetime:
 *   1. an explicit in-process override set from the global `--scope` flag,
 *   2. the LIM_INSTANCE_SCOPE environment variable,
 *   3. the current linked-worktree root, if any,
 *   4. the GLOBAL scope.
 *
 * Steps 3 and 4 require no setup. An explicit override (1/2) always wins, which
 * is the escape hatch for isolating agents that run in separate clones rather
 * than worktrees.
 */

/** Sentinel scope key for the shared, non-worktree "most recent instance" slot. */
export const GLOBAL_SCOPE_KEY = '__global__';

let override: string | undefined;
let cachedDefault: string | undefined;

/**
 * Override the scope key for this process (used by the global `--scope` flag).
 * Passing an empty/undefined value clears the override.
 */
export function setScopeOverride(key: string | undefined): void {
  const trimmed = key?.trim();
  override = trimmed ? normalizeScopeKey(trimmed, true) : undefined;
}

/** Resolve the active scope key. Memoizes only the worktree/global fallback. */
export function getScopeKey(): string {
  if (override) return override;

  const env = process.env['LIM_INSTANCE_SCOPE']?.trim();
  if (env) return normalizeScopeKey(env, true);

  if (cachedDefault === undefined) {
    cachedDefault = computeDefaultScopeKey();
  }
  return cachedDefault;
}

/** True when the active scope is the shared global (non-worktree) slot. */
export function isGlobalScope(): boolean {
  return getScopeKey() === GLOBAL_SCOPE_KEY;
}

/** Human-readable description of the active scope, for messages. */
export function describeScope(): string {
  const key = getScopeKey();
  return key === GLOBAL_SCOPE_KEY ? 'the default (non-worktree) context' : `this directory (${key})`;
}

/** Reset memoized state. Intended for tests only. */
export function resetScopeCacheForTests(): void {
  override = undefined;
  cachedDefault = undefined;
}

function computeDefaultScopeKey(): string {
  const worktreeRoot = linkedWorktreeRoot();
  return worktreeRoot ? normalizeScopeKey(worktreeRoot, false) : GLOBAL_SCOPE_KEY;
}

/**
 * Return the toplevel of the current *linked* worktree, or undefined when we are
 * in a repo's main checkout or not in a git repo at all. A linked worktree is
 * detected by its per-worktree git dir differing from the shared common git dir.
 */
function linkedWorktreeRoot(): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    const [gitDir, commonDir, topLevel] = out.split('\n').map((line) => line.trim());
    if (!gitDir || !commonDir || !topLevel) return undefined;
    const cwd = process.cwd();
    if (path.resolve(cwd, gitDir) === path.resolve(cwd, commonDir)) {
      return undefined; // main checkout
    }
    return topLevel;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a scope key. Real filesystem paths are canonicalized through
 * `realpath` so symlinks and sibling worktrees resolve to stable, distinct
 * keys. Explicit overrides that are not real paths (e.g. an arbitrary label or
 * the GLOBAL sentinel) are kept verbatim so they stay stable regardless of cwd.
 */
function normalizeScopeKey(input: string, allowLiteral: boolean): string {
  try {
    return fs.realpathSync.native(input);
  } catch {
    return allowLiteral ? input : path.resolve(input);
  }
}
