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

/**
 * Watch a folder tree for changes. Uses recursive watch when supported (macOS),
 * otherwise falls back to watching each directory.
 *
 * Returns a handle that can be closed to stop watching.
 */
export async function watchFolderTree(opts: FolderSyncWatcherOptions): Promise<WatcherHandle> {
  const log = opts.log ?? noopLogger;
  const rootPath = opts.rootPath;
  if (!fs.existsSync(rootPath)) {
    throw new Error(`watchFolderTree root does not exist: ${rootPath}`);
  }
  const watcher = fs.watch(rootPath, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const relativePath = filename.split(path.sep).join('/');
    if (opts.ignoreFn(relativePath)) {
      return;
    }
    opts.onChange(relativePath ? `change:${relativePath}` : 'change');
  });
  log('debug', `watchFolderTree(recursive): ${rootPath}`);
  return { close: () => watcher.close() };
}
