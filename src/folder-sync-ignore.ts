import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ignorePkg, { type Ignore } from 'ignore';

const execFileAsync = promisify(execFile);

export type IgnoreFn = (relativePath: string) => boolean;

export type IgnoreLogger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

/** A labeled ignore predicate, so dry-run output can attribute the decision. */
export type AdditionalIgnore = {
  source: string;
  fn: IgnoreFn;
};

export type IgnoreFnOptions = {
  additional?: AdditionalIgnore[];
  basisCacheDir: string;
  log?: IgnoreLogger;
};

/** Why a path is (or isn't) synced; `source`/`rule` identify the deciding layer. */
export type IgnoreDecision = {
  ignored: boolean;
  /** 'built-in', '.limignore', a '.gitignore' path relative to the root, or an AdditionalIgnore source. */
  source?: string;
  /** The matching pattern text, when the deciding layer has one. */
  rule?: string;
};

export type SyncIgnore = {
  /** The boolean predicate walkFiles and the watcher consume. */
  ignores: IgnoreFn;
  /** Full attribution for dry-run reporting. */
  explain: (relativePath: string) => IgnoreDecision;
};

/** Sidecar metadata cache filename inside the basis cache dir (see folder-sync-meta-cache.ts). */
export const META_CACHE_FILENAME = '.limsync-meta.json';

export const LIMIGNORE_FILENAME = '.limignore';

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

// ignorecase: false matches git's default semantics. The package defaults to true,
// which silently drops e.g. `Vendor/` when .gitignore says `vendor/` (Ruby convention).
// allowRelativePaths: true so a `../`-style path doesn't throw mid-sync — treat it as
// "not ignored" and let it through, since the cost of dropping a needed file is higher
// than including an unexpected one.
function newIgnoreInstance(content: string): Ignore {
  return ignorePkg({ ignorecase: false, allowRelativePaths: true }).add(content);
}

function loadIgnoreFile(file: string): Ignore | null {
  try {
    return newIgnoreInstance(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Builds the layered sync ignore for a root directory. Layer order:
 *
 * 1. Hard built-ins, non-overridable: `.git`, `.DS_Store`, the basis cache
 *    dir, and the sync metadata cache. No pattern file can re-include these.
 * 2. `*.xcconfig` force-include (gitignored xcconfigs are still required to
 *    reproduce the build remotely).
 * 3. `.gitignore` files, honored per directory with git's semantics: rules
 *    apply relative to their containing directory, deeper files override
 *    shallower ones, and the contents of an ignored directory can never be
 *    re-included (its `.gitignore` is never even read).
 * 4. Root `.limignore` (same syntax), consulted after every `.gitignore`, for
 *    sync-only exclusions like caches that aren't gitignored.
 * 5. `additional` labeled predicates (default Xcode excludes, CLI --ignore).
 *    These run last and are not overridable by pattern files.
 */
export async function createIgnore(rootDir: string, options: IgnoreFnOptions): Promise<SyncIgnore> {
  const rootResolved = path.resolve(rootDir);

  // Per-directory .gitignore instances, lazily loaded; key is the dir path
  // relative to the root ('' = root), value null when the dir has none.
  const dirIgnores = new Map<string, Ignore | null>();
  const gitignoreFor = (dirRel: string): Ignore | null => {
    let ig = dirIgnores.get(dirRel);
    if (ig === undefined) {
      ig = loadIgnoreFile(path.join(rootResolved, dirRel, '.gitignore'));
      dirIgnores.set(dirRel, ig);
    }
    return ig;
  };
  const limIgnore = loadIgnoreFile(path.join(rootResolved, LIMIGNORE_FILENAME));

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
  // Dedupe by pattern rule so a single bad rule doesn't spam the log per matched file.
  const warnedRules = new Set<string>();

  // Evaluates layers 3-4 for a path whose ancestors are already known to be
  // kept. `testPath` keeps the trailing slash for directories so dir-only
  // rules (`build/`) match. Last decisive match wins; deeper .gitignore
  // files are consulted later, so they naturally override shallower ones,
  // and .limignore is consulted last of the pattern layers.
  const patternDecision = (testPath: string): IgnoreDecision | undefined => {
    const withoutTrailingSlash = testPath.replace(/\/+$/, '');
    const trailingSlash = testPath.endsWith('/') ? '/' : '';
    let decision: IgnoreDecision | undefined;
    const parts = withoutTrailingSlash.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dirRel = parts.slice(0, i).join('/');
      const ig = gitignoreFor(dirRel);
      if (!ig) continue;
      const relToDir = parts.slice(i).join('/') + trailingSlash;
      const result = ig.test(relToDir);
      if (result.ignored || result.unignored) {
        decision = {
          ignored: result.ignored,
          source: dirRel ? `${dirRel}/.gitignore` : '.gitignore',
          ...(result.rule?.pattern !== undefined && { rule: result.rule.pattern }),
        };
      }
    }
    if (limIgnore) {
      const result = limIgnore.test(testPath);
      if (result.ignored || result.unignored) {
        decision = {
          ignored: result.ignored,
          source: LIMIGNORE_FILENAME,
          ...(result.rule?.pattern !== undefined && { rule: result.rule.pattern }),
        };
      }
    }
    return decision;
  };

  // Memoized "is this directory ignored" for ancestor pruning. walkFiles
  // visits directories top-down and prunes, so in practice this is a cache
  // hit per directory; the recursion only runs for out-of-order queries.
  const dirDecisions = new Map<string, IgnoreDecision | undefined>();
  const ignoredAncestorDecision = (dirRel: string): IgnoreDecision | undefined => {
    if (dirRel === '') return undefined;
    if (dirDecisions.has(dirRel)) return dirDecisions.get(dirRel);
    const parentRel = dirRel.includes('/') ? dirRel.slice(0, dirRel.lastIndexOf('/')) : '';
    let decision = ignoredAncestorDecision(parentRel);
    if (!decision) {
      const own = patternDecision(dirRel + '/');
      if (own?.ignored) decision = own;
    }
    dirDecisions.set(dirRel, decision);
    return decision;
  };

  const explain = (relativePath: string): IgnoreDecision => {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return { ignored: false };
    const withoutTrailingSlash = normalized.replace(/\/+$/, '');

    if (
      withoutTrailingSlash === '.git' ||
      withoutTrailingSlash.startsWith('.git/') ||
      withoutTrailingSlash.endsWith('/.git') ||
      withoutTrailingSlash.includes('/.git/') ||
      withoutTrailingSlash === '.DS_Store' ||
      withoutTrailingSlash.endsWith('/.DS_Store') ||
      withoutTrailingSlash === META_CACHE_FILENAME
    ) {
      return { ignored: true, source: 'built-in' };
    }
    if (
      shouldIgnoreBasisCache &&
      (withoutTrailingSlash === basisCacheRelative ||
        withoutTrailingSlash.startsWith(`${basisCacheRelative}/`))
    ) {
      return { ignored: true, source: 'built-in' };
    }
    if (withoutTrailingSlash.endsWith('.xcconfig')) return { ignored: false };

    const parentRel =
      withoutTrailingSlash.includes('/') ?
        withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf('/'))
      : '';
    const ancestor = ignoredAncestorDecision(parentRel);
    const decision = ancestor ?? patternDecision(normalized);
    if (decision?.ignored) {
      if (
        trackedSets &&
        (trackedSets.tracked.has(withoutTrailingSlash) || trackedSets.prefixes.has(withoutTrailingSlash))
      ) {
        const rule = `${decision.source}: ${decision.rule ?? '<unknown>'}`;
        if (!warnedRules.has(rule)) {
          warnedRules.add(rule);
          const msg = `${decision.source} rule '${
            decision.rule ?? '<unknown>'
          }' is dropping '${withoutTrailingSlash}', which is tracked in git. The remote build will not see this path. Remove or scope the rule if you need it synced.`;
          if (log) {
            log('warn', msg);
          } else {
            console.warn('[FolderSync]', msg);
          }
        }
      }
      return decision;
    }
    for (const layer of options.additional ?? []) {
      if (layer.fn(normalized)) {
        return { ignored: true, source: layer.source };
      }
    }
    return { ignored: false };
  };

  return {
    ignores: (relativePath: string) => explain(relativePath).ignored,
    explain,
  };
}

/** Boolean-predicate wrapper over createIgnore for callers that don't need attribution. */
export async function createIgnoreFn(rootDir: string, options: IgnoreFnOptions): Promise<IgnoreFn> {
  return (await createIgnore(rootDir, options)).ignores;
}
