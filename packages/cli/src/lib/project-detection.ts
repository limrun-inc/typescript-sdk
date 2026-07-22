import fs from 'fs';
import path from 'path';

import type { SkillHints } from './skills';

export type ProjectDetection =
  | {
      kind: 'native-ios';
      projectDir: string;
    }
  | {
      kind: 'expo';
      projectDir: string;
    }
  | {
      kind: 'sample';
    };

const DEFAULT_MAX_DEPTH = 2;
const WALK_EXCLUDES = new Set([
  '.git',
  '.limbuild-sandbox',
  '.expo',
  '.pnpm-store',
  '.turbo',
  '.next',
  '.cache',
  'Pods',
  'node_modules',
  'build',
  'dist',
  'out',
  'coverage',
  'DerivedData',
  '.build',
  'Carthage',
]);

function isXcodeBundle(name: string): boolean {
  return name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace');
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkDirs(root: string, maxDepth = DEFAULT_MAX_DEPTH): string[] {
  const dirs: string[] = [];
  const rootPath = path.resolve(root);

  function visit(dir: string, depth: number): void {
    dirs.push(dir);
    if (depth >= maxDepth) return;

    for (const entry of safeReadDir(dir)) {
      if (!entry.isDirectory()) continue;
      if (WALK_EXCLUDES.has(entry.name)) continue;
      if (isXcodeBundle(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  }

  visit(rootPath, 0);
  return dirs;
}

function isPlainFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

interface ParsedPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

function readPackageJson(packageJsonPath: string): ParsedPackageJson | undefined {
  if (!isPlainFile(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as ParsedPackageJson;
  } catch {
    return undefined;
  }
}

function hasDependency(packageJson: ParsedPackageJson | undefined, name: string): boolean {
  return Boolean(packageJson?.dependencies?.[name] || packageJson?.devDependencies?.[name]);
}

function hasExpoDependency(packageJsonPath: string): boolean {
  return hasDependency(readPackageJson(packageJsonPath), 'expo');
}

function isExpoAppDir(dir: string): boolean {
  if (!hasExpoDependency(path.join(dir, 'package.json'))) return false;
  return ['app.json', 'app.config.js', 'app.config.ts'].some((name) => fs.existsSync(path.join(dir, name)));
}

// Unambiguous Bazel workspace markers. Bare BUILD files are intentionally not
// on this list because they are too weak a signal on their own.
const BAZEL_MARKERS = [
  'WORKSPACE',
  'WORKSPACE.bazel',
  'WORKSPACE.bzlmod',
  'MODULE.bazel',
  '.bazelrc',
  '.bazelversion',
];

function isBazelWorkspaceDir(dir: string): boolean {
  return BAZEL_MARKERS.some((marker) => isPlainFile(path.join(dir, marker)));
}

// Detox reads its config from a package.json dependency plus one of these
// config locations (https://wix.github.io/Detox/docs/config/overview).
const DETOX_CONFIG_FILES = [
  '.detoxrc',
  '.detoxrc.js',
  '.detoxrc.json',
  '.detoxrc.cjs',
  'detox.config.js',
  'detox.config.json',
  'detox.config.cjs',
  'detox.config.ts',
];

function isDetoxDir(dir: string): boolean {
  const packageJson = readPackageJson(path.join(dir, 'package.json'));
  if (hasDependency(packageJson, 'detox') || packageJson?.['detox'] !== undefined) return true;
  return DETOX_CONFIG_FILES.some((name) => isPlainFile(path.join(dir, name)));
}

/**
 * Scan the folder for clues that decide whether conditional skills (Bazel,
 * Detox) should be installed by default.
 */
export function scanSkillHints(root = process.cwd()): SkillHints {
  const dirs = walkDirs(root);
  return {
    bazel: dirs.some(isBazelWorkspaceDir),
    detox: dirs.some(isDetoxDir),
  };
}

function iosProjectFiles(dir: string): { workspaces: string[]; projects: string[] } {
  const workspaces: string[] = [];
  const projects: string[] = [];
  for (const entry of safeReadDir(dir)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith('.xcworkspace')) {
      workspaces.push(entry.name);
    } else if (entry.name.endsWith('.xcodeproj')) {
      projects.push(entry.name);
    }
  }
  return { workspaces: workspaces.sort(), projects: projects.sort() };
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function detectProject(root = process.cwd()): ProjectDetection {
  const rootPath = path.resolve(root);
  const dirs = walkDirs(root);
  const iosCandidates = dirs
    .map((dir) => ({ dir, ...iosProjectFiles(dir) }))
    .filter((candidate) => candidate.workspaces.length > 0 || candidate.projects.length > 0);
  const expoCandidates = dirs.filter(isExpoAppDir);

  if (expoCandidates.length === 1) {
    const expoDir = expoCandidates[0]!;
    if (iosCandidates.every((candidate) => isSameOrInside(expoDir, candidate.dir))) {
      return { kind: 'expo', projectDir: expoDir };
    }
  }
  const rootIosCandidates = iosCandidates.filter((candidate) => path.resolve(candidate.dir) === rootPath);
  if (rootIosCandidates.length === 1 && expoCandidates.length === 0) {
    return {
      kind: 'native-ios',
      projectDir: rootIosCandidates[0]!.dir,
    };
  }
  if (iosCandidates.length === 1 && expoCandidates.length === 0) {
    const candidate = iosCandidates[0]!;
    return {
      kind: 'native-ios',
      projectDir: candidate.dir,
    };
  }
  if (iosCandidates.length === 0 && expoCandidates.length === 0) {
    return { kind: 'sample' };
  }
  return { kind: 'sample' };
}
