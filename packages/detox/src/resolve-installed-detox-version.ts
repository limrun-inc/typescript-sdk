import fs from 'fs';
import path from 'path';

export type ResolveInstalledDetoxVersionOptions = {
  /** Message when `node_modules/detox/package.json` is missing. */
  onMissingInstall?: (packageJsonPath: string) => string;
  /** Message when `version` is absent, not a string, or whitespace only. */
  onInvalidVersion?: (packageJsonPath: string) => string;
};

/**
 * Read the semver of the locally installed `detox` package under `cwd`.
 */
export function resolveInstalledDetoxVersion(
  cwd = process.cwd(),
  options?: ResolveInstalledDetoxVersionOptions,
): string {
  const packageJsonPath = path.join(cwd, 'node_modules', 'detox', 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      options?.onMissingInstall?.(packageJsonPath) ??
        'Missing Detox version. Pass version or install detox in the current project.',
    );
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(
      options?.onInvalidVersion?.(packageJsonPath) ?? `Missing Detox version in ${packageJsonPath}`,
    );
  }

  return packageJson.version;
}
