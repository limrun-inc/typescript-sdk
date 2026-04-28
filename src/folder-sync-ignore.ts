import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ignorePkg from 'ignore';

const execFileAsync = promisify(execFile);

export type IgnoreFn = (relativePath: string) => boolean;

export type IgnoreLogger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

export type IgnoreFnOptions = {
  additional?: IgnoreFn;
  basisCacheDir: string;
  log?: IgnoreLogger;
};

function normalizeRelativePath(relativePath: string): string {
  return relativePath
    .split(path.sep)
    .join('/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/');
}

type GitTrackedSets = {
  tracked: Set<string>;
  prefixes: Set<string>;
};

async function getGitTrackedSets(rootDir: string): Promise<GitTrackedSets | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
      cwd: rootDir,
      maxBuffer: 256 * 1024 * 1024,
    });
    const tracked = new Set<string>();
    const prefixes = new Set<string>();
    for (const file of stdout.split('\0')) {
      if (!file) continue;
      tracked.add(file);
      let idx = file.lastIndexOf('/');
      while (idx > 0) {
        prefixes.add(file.substring(0, idx));
        idx = file.lastIndexOf('/', idx - 1);
      }
    }
    return { tracked, prefixes };
  } catch {
    return null;
  }
}

export async function createIgnoreFn(rootDir: string, options: IgnoreFnOptions): Promise<IgnoreFn> {
  const rootResolved = path.resolve(rootDir);
  // ignorecase: false matches git's default semantics. The package defaults to true,
  // which silently drops e.g. `Vendor/` when .gitignore says `vendor/` (Ruby convention).
  // allowRelativePaths: true so a `../`-style path doesn't throw mid-sync — treat it as
  // "not ignored" and let it through, since the cost of dropping a needed file is higher
  // than including an unexpected one.
  const ig = ignorePkg({ ignorecase: false, allowRelativePaths: true });
  const gitignorePath = path.join(rootResolved, '.gitignore');
  try {
    const content = await fs.promises.readFile(gitignorePath, 'utf-8');
    ig.add(content);
  } catch {
    // No .gitignore file, return empty ignore instance
  }
  const basisCacheRelative = normalizeRelativePath(
    path.relative(rootResolved, options.basisCacheDir),
  ).replace(/\/+$/, '');
  const shouldIgnoreBasisCache =
    basisCacheRelative &&
    basisCacheRelative !== '.' &&
    basisCacheRelative !== '..' &&
    !basisCacheRelative.startsWith('../');

  const trackedSets = await getGitTrackedSets(rootResolved);
  const log = options.log;
  // Dedupe by .gitignore rule so a single bad rule doesn't spam the log per matched file.
  const warnedRules = new Set<string>();

  return (relativePath: string) => {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return false;
    const withoutTrailingSlash = normalized.replace(/\/+$/, '');

    if (
      withoutTrailingSlash === '.git' ||
      withoutTrailingSlash.startsWith('.git/') ||
      withoutTrailingSlash.endsWith('/.git') ||
      withoutTrailingSlash.includes('/.git/') ||
      withoutTrailingSlash === '.DS_Store' ||
      withoutTrailingSlash.endsWith('/.DS_Store')
    ) {
      return true;
    }
    if (
      shouldIgnoreBasisCache &&
      (withoutTrailingSlash === basisCacheRelative ||
        withoutTrailingSlash.startsWith(`${basisCacheRelative}/`))
    ) {
      return true;
    }
    if (withoutTrailingSlash.endsWith('.xcconfig')) return false;
    if (ig.ignores(normalized)) {
      if (
        trackedSets &&
        (trackedSets.tracked.has(withoutTrailingSlash) || trackedSets.prefixes.has(withoutTrailingSlash))
      ) {
        const rule = ig.test(normalized).rule?.pattern ?? '<unknown>';
        if (!warnedRules.has(rule)) {
          warnedRules.add(rule);
          const msg = `.gitignore rule '${rule}' is dropping '${withoutTrailingSlash}', which is tracked in git. The remote build will not see this path. Remove or scope the rule if you need it synced.`;
          if (log) {
            log('warn', msg);
          } else {
            console.warn('[FolderSync]', msg);
          }
        }
      }
      return true;
    }
    if (options.additional?.(normalized)) return true;
    return false;
  };
}
