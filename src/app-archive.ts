import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import * as yauzl from 'yauzl';

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

export type PreparedAppBundle = {
  appPath: string;
  cacheIdentityPath: string;
  isArchive: boolean;
  archivePath?: string;
};

export type ArchiveWatcher = {
  close: () => void;
};

const noopLogger: LogFn = () => {};

function stableArchiveRoot(archivePath: string): string {
  const resolved = path.resolve(archivePath);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  const base = path
    .basename(resolved, path.extname(resolved))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const safeBase = base === '' ? 'app' : base;
  return path.join(os.tmpdir(), `limrun-sync-app-${safeBase}-${hash}`);
}

function stableAppPath(archivePath: string): string {
  return path.join(stableArchiveRoot(archivePath), 'Extracted.app');
}

function toZipPath(name: string): string {
  return name.replace(/\\/g, '/');
}

function isUnsafeZipPath(name: string): boolean {
  if (name.includes('\0')) return true;
  if (path.posix.isAbsolute(name)) return true;
  return name.split('/').some((part) => part === '..');
}

function entryMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  return (entryMode(entry) & 0o170000) === 0o120000;
}

function isDirectoryEntry(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith('/');
}

function entryPerm(entry: yauzl.Entry, fallback: number): number {
  return entryMode(entry) & 0o7777 || fallback;
}

async function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  try {
    return await yauzl.openPromise(archivePath, {
      autoClose: false,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch (err) {
    const message = err instanceof Error ? `: ${err.message}` : '';
    throw new Error(
      `The path is not a valid app bundle directory or ZIP/IPA archive: ${archivePath}${message}`,
    );
  }
}

async function readEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  const entries: yauzl.Entry[] = [];
  for await (const entry of zip.eachEntry()) {
    entries.push(entry);
  }
  return entries;
}

async function ensureDirectoryNotSymlink(dir: string): Promise<void> {
  const stat = await fs.promises.lstat(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  await fs.promises.mkdir(dir, { recursive: true });
}

function discoverPayloadApp(entries: yauzl.Entry[], archivePath: string): string {
  const appNames = new Set<string>();
  const appsWithInfoPlist = new Set<string>();

  for (const entry of entries) {
    const name = toZipPath(entry.fileName);
    if (isUnsafeZipPath(name)) {
      throw new Error(`ZIP entry has an unsafe path: ${entry.fileName}`);
    }
    if (isDirectoryEntry(entry)) {
      continue;
    }
    const rest = name.startsWith('Payload/') ? name.slice('Payload/'.length) : '';
    if (rest === '') {
      continue;
    }
    const [appName, ...parts] = rest.split('/');
    if (!appName?.endsWith('.app')) {
      continue;
    }
    appNames.add(appName);
    if (parts.join('/') === 'Info.plist') {
      appsWithInfoPlist.add(appName);
    }
  }

  if (appNames.size === 0) {
    throw new Error(`ZIP/IPA archive contains no Payload/*.app bundle: ${archivePath}`);
  }
  if (appNames.size > 1) {
    throw new Error(
      `ZIP/IPA archive contains more than one Payload/*.app bundle (${[...appNames].join(
        ', ',
      )}); expected exactly one`,
    );
  }

  const appName = [...appNames][0]!;
  if (!appsWithInfoPlist.has(appName)) {
    throw new Error(`ZIP/IPA archive app bundle is missing Info.plist: Payload/${appName}/Info.plist`);
  }
  return appName;
}

async function copyExtractedAppIntoStableRoot(stagingAppPath: string, appPath: string): Promise<void> {
  await ensureDirectoryNotSymlink(appPath);
  const existing = await fs.promises.readdir(appPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  await Promise.all(
    existing.map((name) => fs.promises.rm(path.join(appPath, name), { recursive: true, force: true })),
  );
  await fs.promises.cp(stagingAppPath, appPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
    verbatimSymlinks: true,
  });
}

async function extractEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  target: string,
  appRoot: string,
): Promise<void> {
  if (isDirectoryEntry(entry)) {
    await fs.promises.mkdir(target, { recursive: true, mode: entryPerm(entry, 0o755) });
    return;
  }

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  if (isSymlinkEntry(entry)) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const linkTarget = Buffer.concat(chunks).toString('utf8');
    const resolved = path.resolve(path.dirname(target), linkTarget);
    const appRootResolved = path.resolve(appRoot);
    if (resolved !== appRootResolved && !resolved.startsWith(appRootResolved + path.sep)) {
      throw new Error(`ZIP/IPA symlink escapes app bundle: ${entry.fileName} -> ${linkTarget}`);
    }
    await fs.promises.rm(target, { force: true });
    await fs.promises.symlink(linkTarget, target);
    return;
  }

  const stream = await zip.openReadStreamPromise(entry);
  await pipeline(stream, fs.createWriteStream(target, { mode: entryPerm(entry, 0o644) }));
  await fs.promises.chmod(target, entryPerm(entry, 0o644));
}

export async function extractAppArchiveToStablePath(archivePath: string): Promise<PreparedAppBundle> {
  const resolvedArchivePath = path.resolve(archivePath);
  const appPath = stableAppPath(resolvedArchivePath);
  const stableRoot = path.dirname(appPath);
  const stagingRoot = path.join(stableRoot, `.staging-${process.pid}-${Date.now()}`);

  await ensureDirectoryNotSymlink(stableRoot);
  const zip = await openZip(resolvedArchivePath);
  try {
    const entries = await readEntries(zip);
    const appName = discoverPayloadApp(entries, resolvedArchivePath);
    const payloadPrefix = `Payload/${appName}/`;
    const stagingAppPath = path.join(stagingRoot, path.basename(appPath));
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });

    for (const entry of entries) {
      const name = toZipPath(entry.fileName);
      if (name !== `Payload/${appName}` && !name.startsWith(payloadPrefix)) {
        continue;
      }
      const rel = name === `Payload/${appName}` ? '' : name.slice(payloadPrefix.length);
      if (rel === '') {
        await fs.promises.mkdir(stagingAppPath, { recursive: true });
        continue;
      }
      if (isUnsafeZipPath(rel)) {
        throw new Error(`ZIP entry has an unsafe app-relative path: ${entry.fileName}`);
      }
      const target = path.join(stagingAppPath, rel.split('/').join(path.sep));
      const stagingAppResolved = path.resolve(stagingAppPath);
      const targetResolved = path.resolve(target);
      if (
        targetResolved !== stagingAppResolved &&
        !targetResolved.startsWith(stagingAppResolved + path.sep)
      ) {
        throw new Error(`ZIP entry escapes app bundle: ${entry.fileName}`);
      }
      await extractEntry(zip, entry, target, stagingAppPath);
    }

    await copyExtractedAppIntoStableRoot(stagingAppPath, appPath);
    return {
      appPath,
      cacheIdentityPath: resolvedArchivePath,
      isArchive: true,
      archivePath: resolvedArchivePath,
    };
  } finally {
    zip.close();
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function prepareAppBundlePath(inputPath: string): Promise<PreparedAppBundle> {
  const resolvedPath = path.resolve(inputPath);
  const stat = await fs.promises.stat(resolvedPath);
  if (stat.isDirectory()) {
    return {
      appPath: resolvedPath,
      cacheIdentityPath: resolvedPath,
      isArchive: false,
    };
  }
  if (!stat.isFile()) {
    throw new Error(`The path is neither an app bundle directory nor a ZIP/IPA archive: ${inputPath}`);
  }
  return await extractAppArchiveToStablePath(resolvedPath);
}

export function watchAppArchive(opts: { archivePath: string; log?: LogFn }): ArchiveWatcher {
  const archivePath = path.resolve(opts.archivePath);
  const log = opts.log ?? noopLogger;
  const parentDir = path.dirname(archivePath);
  const archiveBase = path.basename(archivePath);
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let queued = false;
  let closed = false;

  const run = async () => {
    if (closed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      await extractAppArchiveToStablePath(archivePath);
      log('debug', `re-extracted ZIP/IPA archive: ${archivePath}`);
    } catch (err) {
      log(
        'error',
        `failed to re-extract ZIP/IPA archive ${archivePath}: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void run();
      }
    }
  };

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, 500);
  };

  const watcher = fs.watch(parentDir, (_eventType, filename) => {
    if (!filename || filename.toString() === archiveBase) {
      schedule();
    }
  });
  log('debug', `watchAppArchive: ${archivePath}`);

  return {
    close: () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      watcher.close();
    },
  };
}
