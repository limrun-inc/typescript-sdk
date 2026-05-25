import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import yaml from 'js-yaml';

export const DEFAULT_SKILLS_OWNER = 'limrun-inc';
export const DEFAULT_SKILLS_REPO = 'skills';
export const DEFAULT_SKILLS_REF = 'main';
const DEFAULT_CLONE_TIMEOUT_MS = 300_000;
const CLONE_TIMEOUT_MS = (() => {
  const raw = process.env.SKILLS_CLONE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CLONE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLONE_TIMEOUT_MS;
})();
const execFileAsync = promisify(execFile);

interface CatalogFile {
  schemaVersion: number;
  skills: Array<{
    name: string;
    defaultSelected: boolean;
  }>;
}

export interface RemoteSkill {
  name: string;
  description: string;
  defaultSelected: boolean;
  sourceDir: string;
}

export interface LoadedRemoteSkills {
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  rootDir: string;
  skillsRoot: string;
  skills: RemoteSkill[];
  cleanup(): void;
}

export interface LoadRemoteSkillsOptions {
  owner?: string;
  repo?: string;
  ref?: string;
  cloneImpl?: (owner: string, repo: string, ref: string) => Promise<ClonedSkillsRepo>;
}

export class RemoteSkillsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteSkillsError';
  }
}

export interface ClonedSkillsRepo {
  rootDir: string;
  commit: string;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RemoteSkillsError(`${label} must be a non-empty string`);
  }
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const normalizedBase = path.normalize(path.resolve(basePath));
  const normalizedTarget = path.normalize(path.resolve(targetPath));
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + path.sep);
}

function assertSafeSkillName(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new RemoteSkillsError(`${label} must be a lowercase hyphenated skill name`);
  }
}

function cleanupSkillsTempDir(rootDir: string): void {
  const tmpRoot = os.tmpdir();
  if (!isPathInside(tmpRoot, rootDir) || path.resolve(rootDir) === path.resolve(tmpRoot)) {
    throw new RemoteSkillsError(`Refusing to clean up non-temporary skills directory: ${rootDir}`);
  }

  fs.rmSync(rootDir, { recursive: true, force: true });
}

function parseCatalog(text: string): CatalogFile {
  let catalog: unknown;
  try {
    catalog = JSON.parse(text);
  } catch (err) {
    throw new RemoteSkillsError(`catalog.json is invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new RemoteSkillsError('catalog.json must be an object');
  }

  const parsed = catalog as Partial<CatalogFile>;
  if (parsed.schemaVersion !== 1) {
    throw new RemoteSkillsError('catalog.json schemaVersion must be 1');
  }
  if (!Array.isArray(parsed.skills)) {
    throw new RemoteSkillsError('catalog.json skills must be an array');
  }
  for (const [index, skill] of parsed.skills.entries()) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      throw new RemoteSkillsError(`catalog.json skills[${index}] must be an object`);
    }
    assertString(skill.name, `catalog.json skills[${index}].name`);
    assertSafeSkillName(skill.name, `catalog.json skills[${index}].name`);
    if (typeof skill.defaultSelected !== 'boolean') {
      throw new RemoteSkillsError(`catalog.json skills[${index}].defaultSelected must be a boolean`);
    }
  }
  return parsed as CatalogFile;
}

function parseSkillFrontmatter(skillName: string, text: string): { name: string; description: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new RemoteSkillsError(`skills/${skillName}/SKILL.md is missing YAML frontmatter`);
  }

  let frontmatter: unknown;
  try {
    frontmatter = yaml.load(match[1]);
  } catch (err) {
    throw new RemoteSkillsError(
      `skills/${skillName}/SKILL.md has invalid YAML frontmatter: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new RemoteSkillsError(`skills/${skillName}/SKILL.md frontmatter must be an object`);
  }

  const parsed = frontmatter as { name?: unknown; description?: unknown };
  assertString(parsed.name, `skills/${skillName}/SKILL.md frontmatter name`);
  assertSafeSkillName(parsed.name, `skills/${skillName}/SKILL.md frontmatter name`);
  assertString(parsed.description, `skills/${skillName}/SKILL.md frontmatter description`);
  if (parsed.name !== skillName) {
    throw new RemoteSkillsError(`skills/${skillName}/SKILL.md frontmatter name must match directory name`);
  }

  return { name: parsed.name, description: parsed.description };
}

function readJsonFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new RemoteSkillsError(
      `Failed to read ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function cloneSkillsRepo(owner: string, repo: string, ref: string): Promise<ClonedSkillsRepo> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-skills-'));
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  const cloneArgs = [
    '-c',
    'filter.lfs.required=false',
    '-c',
    'filter.lfs.smudge=',
    '-c',
    'filter.lfs.clean=',
    '-c',
    'filter.lfs.process=',
    'clone',
    '--depth',
    '1',
    '--branch',
    ref,
    repoUrl,
    rootDir,
  ];
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };

  try {
    await execFileAsync('git', cloneArgs, { env, timeout: CLONE_TIMEOUT_MS });
    const { stdout } = await execFileAsync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], {
      env,
      timeout: 30_000,
    });
    return { rootDir, commit: stdout.trim() };
  } catch (err) {
    cleanupSkillsTempDir(rootDir);
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') {
      throw new RemoteSkillsError('Failed to clone Limrun skills: git executable was not found');
    }
    if (message.includes('timed out') || message.includes('ETIMEDOUT')) {
      throw new RemoteSkillsError(
        `Failed to clone Limrun skills: clone timed out after ${Math.round(CLONE_TIMEOUT_MS / 1000)}s`,
      );
    }
    if (
      message.includes('Authentication failed') ||
      message.includes('could not read Username') ||
      message.includes('Permission denied') ||
      message.includes('Repository not found')
    ) {
      throw new RemoteSkillsError(`Failed to clone Limrun skills: authentication failed for ${repoUrl}`);
    }
    throw new RemoteSkillsError(`Failed to clone Limrun skills: ${message}`);
  }
}

function loadSkillsFromCheckout(params: {
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  rootDir: string;
}): LoadedRemoteSkills {
  const { owner, repo, ref, commit, rootDir } = params;
  const skillsRoot = path.join(rootDir, 'skills');
  const catalogPath = path.join(rootDir, 'catalog.json');
  const catalog = parseCatalog(readJsonFile(catalogPath));
  const catalogNames = catalog.skills.map((skill) => skill.name);
  const duplicateCatalogNames = catalogNames.filter((name, index) => catalogNames.indexOf(name) !== index);
  if (duplicateCatalogNames.length > 0) {
    throw new RemoteSkillsError(
      `catalog.json has duplicate skill names: ${[...new Set(duplicateCatalogNames)].join(', ')}`,
    );
  }
  if (!catalog.skills.some((skill) => skill.defaultSelected)) {
    throw new RemoteSkillsError('catalog.json must mark at least one skill as defaultSelected');
  }

  const skills = catalog.skills.map((catalogSkill) => {
    const sourceDir = path.join(skillsRoot, catalogSkill.name);
    if (!isPathInside(skillsRoot, sourceDir)) {
      throw new RemoteSkillsError(`catalog.json skill escapes skills directory: ${catalogSkill.name}`);
    }
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new RemoteSkillsError(`catalog.json entries missing from skills/: ${catalogSkill.name}`);
    }
    const skillMdPath = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      throw new RemoteSkillsError(`Downloaded skill is missing skills/${catalogSkill.name}/SKILL.md`);
    }
    const frontmatter = parseSkillFrontmatter(catalogSkill.name, fs.readFileSync(skillMdPath, 'utf8'));
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      defaultSelected: catalogSkill.defaultSelected,
      sourceDir,
    };
  });

  return {
    owner,
    repo,
    ref,
    commit,
    rootDir,
    skillsRoot,
    skills,
    cleanup: () => cleanupSkillsTempDir(rootDir),
  };
}

export async function loadRemoteSkills(options: LoadRemoteSkillsOptions = {}): Promise<LoadedRemoteSkills> {
  const owner = options.owner ?? DEFAULT_SKILLS_OWNER;
  const repo = options.repo ?? DEFAULT_SKILLS_REPO;
  const ref = options.ref ?? DEFAULT_SKILLS_REF;
  const cloneImpl = options.cloneImpl ?? cloneSkillsRepo;
  const cloned = await cloneImpl(owner, repo, ref);
  try {
    return loadSkillsFromCheckout({
      owner,
      repo,
      ref,
      commit: cloned.commit,
      rootDir: cloned.rootDir,
    });
  } catch (err) {
    cleanupSkillsTempDir(cloned.rootDir);
    throw err;
  }
}

export const __remoteSkillsTestUtils = {
  cleanupSkillsTempDir,
  loadSkillsFromCheckout,
};
