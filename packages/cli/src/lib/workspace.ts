import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Persistent "directory -> workspace name" assignments created by
 * `lim set-workspace-dir`. This lets a plain directory (one that is not a git
 * repo or worktree) opt into an isolated workspace, or lets several directories
 * deliberately share one workspace by assigning them the same name.
 *
 * Kept in its own module (no dependency on config.ts) so scope.ts can consult it
 * during scope resolution without creating an import cycle.
 */

const CONFIG_DIR = path.join(os.homedir(), '.lim');
const WORKSPACE_DIRS_FILE = path.join(CONFIG_DIR, 'workspace-dirs.json');
const SCHEMA_VERSION = 1;

interface WorkspaceDirsFile {
  version: number;
  /** Map of normalized absolute directory path -> workspace name. */
  dirs: Record<string, string>;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function readFileRaw(): WorkspaceDirsFile {
  if (!fs.existsSync(WORKSPACE_DIRS_FILE)) return { version: SCHEMA_VERSION, dirs: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACE_DIRS_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.dirs && typeof parsed.dirs === 'object') {
      const dirs: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.dirs as Record<string, unknown>)) {
        if (typeof value === 'string') dirs[key] = value;
      }
      return { version: SCHEMA_VERSION, dirs };
    }
  } catch {
    // Corrupt file; treat as empty.
  }
  return { version: SCHEMA_VERSION, dirs: {} };
}

function writeFileAtomic(file: WorkspaceDirsFile): void {
  ensureConfigDir();
  const tmp = `${WORKSPACE_DIRS_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, WORKSPACE_DIRS_FILE);
}

/** Canonicalize a directory path (realpath when it exists, else resolve). */
export function normalizeDir(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Bind a directory to a workspace name. */
export function assignWorkspaceDir(dir: string, name: string): void {
  const file = readFileRaw();
  file.dirs[normalizeDir(dir)] = name;
  writeFileAtomic(file);
}

/** Remove a directory's workspace binding. Returns whether anything was removed. */
export function unassignWorkspaceDir(dir: string): boolean {
  const file = readFileRaw();
  const key = normalizeDir(dir);
  if (!(key in file.dirs)) return false;
  delete file.dirs[key];
  writeFileAtomic(file);
  return true;
}

/** A directory's nearest workspace assignment: the directory that holds it and the name. */
export interface WorkspaceMatch {
  /** Normalized directory the assignment is attached to (cwd or an ancestor). */
  dir: string;
  /** Assigned workspace name. */
  name: string;
}

/**
 * Resolve the nearest workspace assignment for `dir`, walking up parent
 * directories so a subdirectory inherits its closest ancestor's assignment
 * (mirroring how a git worktree root applies to everything beneath it). Returns
 * both the matched directory and name so callers can reason about specificity.
 */
export function lookupWorkspaceMatch(dir: string): WorkspaceMatch | undefined {
  const file = readFileRaw();
  if (Object.keys(file.dirs).length === 0) return undefined;
  let current = normalizeDir(dir);
  for (;;) {
    const name = file.dirs[current];
    if (name) return { dir: current, name };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Convenience wrapper returning only the workspace name. */
export function lookupWorkspaceForDir(dir: string): string | undefined {
  return lookupWorkspaceMatch(dir)?.name;
}

/** All directory -> workspace assignments. */
export function listWorkspaceDirs(): Record<string, string> {
  return readFileRaw().dirs;
}
