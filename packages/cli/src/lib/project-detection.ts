import fs from 'fs';
import path from 'path';

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

function hasExpoDependency(packageJsonPath: string): boolean {
  if (!isPlainFile(packageJsonPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(parsed.dependencies?.expo || parsed.devDependencies?.expo);
  } catch {
    return false;
  }
}

function isExpoAppDir(dir: string): boolean {
  if (!hasExpoDependency(path.join(dir, 'package.json'))) return false;
  return ['app.json', 'app.config.js', 'app.config.ts'].some((name) => fs.existsSync(path.join(dir, name)));
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
