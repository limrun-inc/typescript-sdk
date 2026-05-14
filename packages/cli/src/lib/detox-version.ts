import fs from 'fs';
import path from 'path';

/**
 * Intentionally not wired through `@limrun/detox` like `@limrun/api`: this is a tiny read of
 * `node_modules/detox/package.json`, and a CLI dependency on the Detox helper package pulled in
 * TypeScript `exports`/monorepo `paths` complexity (subpaths, build order, gitignored `dist`)
 * out of proportion to the behavior.
 *
 * Logic matches `packages/detox/src/resolve-installed-detox-version.ts` — keep them in sync.
 * If `@limrun/detox` becomes a boring registry dependency, replace this with an import from that
 * package and delete the duplication.
 */
export function resolveLocalDetoxVersion(cwd = process.cwd()): string {
  const packageJsonPath = path.join(cwd, 'node_modules', 'detox', 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      `Missing --detox-version and no local Detox install was found at ${packageJsonPath}. Install detox in this project or pass --detox-version.`,
    );
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(`Missing Detox version in ${packageJsonPath}. Pass --detox-version explicitly.`);
  }

  return packageJson.version;
}
