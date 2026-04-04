import fs from 'fs';
import path from 'path';
import { IgnoreFn } from './folder-sync-ignore';

export type FolderSyncWatcherOptions = {
  rootPath: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  ignoreFn: IgnoreFn;
  onChange: (reason: string) => void;
};

type WatcherHandle = { close: () => void };

const noopLogger = (_level: 'debug' | 'info' | 'warn' | 'error', _msg: string) => {};

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function shouldWatchRelativePath(relativePath: string, ignoreFn: IgnoreFn, isDirectory = false): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return !ignoreFn(isDirectory ? `${normalized}/` : normalized);
}

async function listDirsRecursive(root: string, ignoreFn: IgnoreFn): Promise<string[]> {
  const dirs: string[] = [root];
  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full);
      if (!shouldWatchRelativePath(rel, ignoreFn, true)) continue;
      dirs.push(full);
      queue.push(full);
    }
  }
  return dirs;
}

/**
 * Watch a folder tree for changes. Uses recursive watch when supported (macOS),
 * otherwise falls back to watching each directory. Debounced.
 *
 * Returns a handle that can be closed to stop watching.
 */
export async function watchFolderTree(opts: FolderSyncWatcherOptions): Promise<WatcherHandle> {
  const log = opts.log ?? noopLogger;
  const debounceMs = 500;
  const rootPath = opts.rootPath;
  if (!fs.existsSync(rootPath)) {
    throw new Error(`watchFolderTree root does not exist: ${rootPath}`);
  }
  let timer: NodeJS.Timeout | undefined;
  const schedule = (reason: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => opts.onChange(reason), debounceMs);
  };
  const watcher = fs.watch(rootPath, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const relativePath = normalizeRelativePath(filename);
    if (relativePath && !shouldWatchRelativePath(relativePath, opts.ignoreFn)) {
      return;
    }
    schedule(relativePath ? `change:${relativePath}` : 'change');
  });
  log('debug', `watchFolderTree(recursive): ${rootPath}`);
  return { close: () => watcher.close() };
}
