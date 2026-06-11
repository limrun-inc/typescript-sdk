import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { lookupWorkspaceMatch } from './workspace';

/**
 * A "scope" (surfaced to users as a "workspace") isolates the most-recently-used
 * instance per directory so that separate git worktrees / clones (and the
 * parallel AI agents working in them) each get their own last-instance binding
 * instead of all sharing one slot.
 *
 * Resolution order (first match wins), memoized for the lifetime of the process:
 *   1. an explicit in-process override set from the global `--workspace` flag,
 *   2. the LIM_WORKSPACE environment variable,
 *   3. the most specific of: a `lim set-workspace-dir` assignment (cwd or an
 *      ancestor) and the current git repo/worktree root,
 *   4. GLOBAL_SCOPE_KEY when neither applies.
 *
 * These require zero setup. Any command run inside a git repo (a clone or a
 * linked worktree) resolves to that root and is isolated from every other
 * checkout. A `set-workspace-dir` assignment governs its directory and
 * everything beneath it, EXCEPT a nested git worktree/clone whose root is deeper
 * than the assignment keeps its own isolation (most-specific boundary wins).
 * Anything else shares a single global slot, preserving the convenient "use my
 * most recent instance anywhere" behavior for casual, non-repo usage.
 */

/**
 * Shared scope used for invocations that are not inside any git repo. It is a
 * non-path sentinel so it can never collide with a real directory scope key.
 */
export const GLOBAL_SCOPE_KEY = '__lim_global__';

/** Whether a resolved scope key is the shared non-repo global slot. */
export function isGlobalScopeKey(key: string): boolean {
  return key === GLOBAL_SCOPE_KEY;
}

let override: string | undefined;
let cachedDefault: string | undefined;

/**
 * Override the scope key for this process (used by the global `--workspace` flag).
 * Passing an empty/undefined value clears the override.
 */
export function setScopeOverride(key: string | undefined): void {
  const trimmed = key?.trim();
  override = trimmed ? normalizeScopeKey(trimmed, true) : undefined;
}

/** Resolve the active scope key. Memoizes only the assignment/git/global fallback. */
export function getScopeKey(): string {
  if (override) return override;

  const env = process.env['LIM_WORKSPACE']?.trim();
  if (env) return normalizeScopeKey(env, true);

  if (cachedDefault === undefined) {
    cachedDefault = computeDefaultScopeKey();
  }
  return cachedDefault;
}

/** Reset memoized state. Intended for tests only. */
export function resetScopeCacheForTests(): void {
  override = undefined;
  cachedDefault = undefined;
}

function computeDefaultScopeKey(): string {
  const cwd = process.cwd();
  const match = lookupWorkspaceMatch(cwd);
  const top = gitWorktreeRoot();
  const gitRoot = top ? normalizeScopeKey(top, false) : undefined;

  if (match && gitRoot) {
    // Both boundaries cover the cwd. The more specific (deeper) one wins, so a
    // nested git worktree/clone keeps its own isolation even under a broad
    // parent assignment, while an assignment at or below the git root still
    // overrides git auto-detection.
    return isStrictDescendant(gitRoot, match.dir) ? gitRoot : match.name;
  }
  if (match) return match.name;
  if (gitRoot) return gitRoot;
  // Outside any repo and with no assignment, share the global slot.
  return GLOBAL_SCOPE_KEY;
}

/** Whether `child` is a strict subdirectory of `parent` (both normalized absolute paths). */
function isStrictDescendant(child: string, parent: string): boolean {
  if (child === parent) return false;
  const base = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(base);
}

function gitWorktreeRoot(): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a scope key. Real filesystem paths are canonicalized through
 * `realpath` so symlinks and sibling worktrees resolve to stable, distinct
 * keys. Explicit overrides that are not real paths (e.g. an arbitrary label)
 * are kept verbatim so they stay stable regardless of the working directory.
 */
function normalizeScopeKey(input: string, allowLiteral: boolean): string {
  try {
    return fs.realpathSync.native(input);
  } catch {
    return allowLiteral ? input : path.resolve(input);
  }
}
