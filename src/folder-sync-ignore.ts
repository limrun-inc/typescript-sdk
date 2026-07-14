import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ignorePkg, { type Ignore } from 'ignore';

const execFileAsync = promisify(execFile);

export type IgnoreFn = (relativePath: string) => boolean;

export type IgnoreLogger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

export type IgnoreFnOptions = {
  /** User-supplied extra excludes (the CLI's --ignore). Consulted after every built-in layer. */
  additional?: IgnoreFn;
  /**
   * User-supplied force-includes (the CLI's --include): matches sync even when
   * covered by a built-in exclude, gitignored, or covered by the default Xcode
   * excludes. The basis cache remains excluded to prevent sync loops. Note:
   * the walk prunes excluded directories, so to rescue files under a
   * wholly-excluded parent the predicate must also match the parent directory
   * paths (probed with a trailing slash), e.g. `^ios/` reaches
   * `ios/GeneratedKit/...` but `GeneratedKit/` alone does not.
   */
  include?: IgnoreFn;
  /**
   * "Xcode project sync mode." Enables the default Xcode/dependency excludes
   * (build/, Pods/, xcuserdata/, …) and nested-.gitignore honoring. When
   * unset (e.g. the app-bundle install sync) only the root .gitignore is
   * read, so a build artifact isn't reshaped by gitignore files embedded
   * in it.
   */
  xcodeDefaults?: boolean;
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

// Root-anchored (top-level only) default excludes; nested build junk is the
// project's own nested .gitignore's job. xcuserdata/.dSYM below are any-depth.
const XCODE_DEFAULT_EXCLUDE_PREFIXES = [
  'build/',
  '.build/',
  'DerivedData/',
  'Index.noindex/',
  'ModuleCache.noindex/',
  '.index-build/',
  '.swiftpm/',
  'Pods/',
  'Carthage/Build/',
];

/**
 * Builds the layered sync ignore predicate. First decisive answer wins:
 *
 *  1. The basis cache: excluded, never overridable.
 *  2. User include (--include): explicit intent beats every other exclusion.
 *  3. `.git` and `.DS_Store`.
 *  4. Default Xcode/dependency excludes (when xcodeDefaults is set).
 *  5. Built-in force-include: `*.xcconfig` (gitignored xcconfigs are still
 *     required to reproduce the build remotely). Gitignored projects are NOT
 *     force-included: limbuild regenerates them from project.yml, and
 *     exact-version holdouts force-sync theirs with `--include`.
 *  6. `.gitignore` chain: the root file, plus nested ones with git semantics
 *     when xcodeDefaults is set (rules bind relative to their containing
 *     directory, deeper files override shallower ones). Only a decisive
 *     *exclude* short-circuits; a negation re-include defers to layer 7.
 *     Directory pruning in the walk means only layers 2 and 5 can reach a
 *     file whose parent directory is gitignore-excluded, and only when the
 *     predicate matches the pruned parent directory paths too.
 *  7. User ignore (--ignore).
 */
export async function createIgnoreFn(rootDir: string, options: IgnoreFnOptions): Promise<IgnoreFn> {
  const rootResolved = path.resolve(rootDir);

  // Per-directory .gitignore instances, lazily loaded; key is the dir path
  // relative to the root ('' = root), value null when the dir has none.
  // ignorecase: false matches git's default semantics. The package defaults to true,
  // which silently drops e.g. `Vendor/` when .gitignore says `vendor/` (Ruby convention).
  // allowRelativePaths: true so a `../`-style path doesn't throw mid-sync — treat it as
  // "not ignored" and let it through, since the cost of dropping a needed file is higher
  // than including an unexpected one.
  const dirIgnores = new Map<string, Ignore | null>();
  const gitignoreFor = (dirRel: string): Ignore | null => {
    let ig = dirIgnores.get(dirRel);
    if (ig !== undefined) return ig;
    try {
      const content = fs.readFileSync(
        path.join(rootResolved, dirRel.split('/').join(path.sep), '.gitignore'),
        'utf-8',
      );
      ig = ignorePkg({ ignorecase: false, allowRelativePaths: true }).add(content);
    } catch {
      ig = null;
    }
    dirIgnores.set(dirRel, ig);
    return ig;
  };

  // xcodeDefaults selects "Xcode project sync mode": besides the default junk
  // excludes it also enables nested-.gitignore honoring and the project-file
  // force-includes below. Callers that don't set it (e.g. the app-bundle
  // install sync) keep the legacy behavior: root-only .gitignore and no
  // project force-includes, so a build artifact isn't reshaped by gitignore
  // files or Xcode-specific rules that happen to sit inside it.
  const nestedGitignore = !!options.xcodeDefaults;

  // Evaluates the .gitignore chain for a path (trailing slash preserved so
  // dir-only rules like `build/` match the directory itself). Files are
  // consulted root-to-deepest; the last decisive match wins, so deeper
  // files naturally override shallower ones. When nestedGitignore is off,
  // only the root .gitignore is consulted.
  const gitignoreDecision = (testPath: string): { ignored: boolean; rule?: string } | undefined => {
    const withoutTrailingSlash = testPath.replace(/\/+$/, '');
    const trailingSlash = testPath.endsWith('/') ? '/' : '';
    const parts = withoutTrailingSlash.split('/');
    let decision: { ignored: boolean; rule?: string } | undefined;
    const depth = nestedGitignore ? parts.length : 1;
    for (let i = 0; i < depth; i++) {
      const ig = gitignoreFor(parts.slice(0, i).join('/'));
      if (!ig) continue;
      const result = ig.test(parts.slice(i).join('/') + trailingSlash);
      if (result.ignored || result.unignored) {
        decision = { ignored: result.ignored };
        const rule = (result as { rule?: { pattern?: string } }).rule?.pattern;
        if (rule !== undefined) decision.rule = rule;
      }
    }
    return decision;
  };

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

    // 1. The basis cache must not sync itself, even when --include matches.
    if (
      shouldIgnoreBasisCache &&
      (withoutTrailingSlash === basisCacheRelative ||
        withoutTrailingSlash.startsWith(`${basisCacheRelative}/`))
    ) {
      return true;
    }
    // 2. User include.
    if (options.include?.(normalized)) return false;
    // 3. Built-in excludes.
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
    // 4. Default Xcode/dependency excludes.
    if (options.xcodeDefaults) {
      for (const prefix of XCODE_DEFAULT_EXCLUDE_PREFIXES) {
        if (normalized.startsWith(prefix)) return true;
      }
      if (normalized.includes('/xcuserdata/') || normalized.includes('.dSYM/')) return true;
    }
    // 5. Built-in force-include: gitignored xcconfigs are still required to
    // reproduce the build remotely. Gitignored .xcodeproj bundles are NOT
    // force-included: limbuild regenerates them from project.yml, and
    // exact-version holdouts force-sync theirs with --include.
    if (withoutTrailingSlash.endsWith('.xcconfig')) return false;
    // 6. The .gitignore chain. Only a decisive *exclude* short-circuits; a
    // negation re-include (decision.ignored === false) still falls through to
    // the user --ignore layer, matching the pre-restructure precedence where
    // gitignore never overrode --ignore for a re-included path.
    const decision = gitignoreDecision(normalized);
    if (decision?.ignored) {
      if (
        trackedSets &&
        (trackedSets.tracked.has(withoutTrailingSlash) || trackedSets.prefixes.has(withoutTrailingSlash))
      ) {
        const rule = decision.rule ?? '<unknown>';
        if (!warnedRules.has(rule)) {
          warnedRules.add(rule);
          const msg = `.gitignore rule '${rule}' is dropping '${withoutTrailingSlash}', which is tracked in git. The remote build will not see this path. Remove or scope the rule, or pass --include, if you need it synced.`;
          if (log) {
            log('warn', msg);
          } else {
            console.warn('[FolderSync]', msg);
          }
        }
      }
      return true;
    }
    // 7. User ignore.
    if (options.additional?.(normalized)) return true;
    return false;
  };
}
