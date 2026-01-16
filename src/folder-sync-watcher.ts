import fs from 'fs';
import path from 'path';

export type FolderSyncWatcherOptions = {
  rootPath: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  onChange: (reason: string) => void;
};

type WatcherHandle = { close: () => void };

const noopLogger = (_level: 'debug' | 'info' | 'warn' | 'error', _msg: string) => {};

async function listDirsRecursive(root: string): Promise<string[]> {
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

  // Preferred: recursive watch
  try {
    const watcher = fs.watch(rootPath, { recursive: true }, (_eventType, filename) => {
      schedule(filename ? `change:${filename.toString()}` : 'change');
    });
    log('info', `watchFolderTree(recursive): ${rootPath}`);
    return { close: () => watcher.close() };
  } catch (err) {
    log(
      'warn',
      `watchFolderTree: recursive unsupported, using per-directory watches: ${(err as Error).message}`,
    );
  }

  // Fallback: watch every directory. Also re-scan on any event to pick up newly-created dirs.
  const watchers = new Map<string, fs.FSWatcher>();

  const ensureWatched = async () => {
    const dirs = await listDirsRecursive(rootPath);
    for (const d of dirs) {
      if (watchers.has(d)) continue;
      try {
        const w = fs.watch(d, (_eventType, filename) => {
          schedule(filename ? `change:${filename.toString()}` : 'change');
          void ensureWatched();
        });
        watchers.set(d, w);
      } catch {
        // ignore dirs we can't watch
      }
    }
  };

  await ensureWatched();
  log('info', `watchFolderTree(per-dir): ${rootPath} dirs=${watchers.size}`);

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}
