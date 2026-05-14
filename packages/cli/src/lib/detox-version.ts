import fs from 'fs';
import path from 'path';

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
