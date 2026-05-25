import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

export const DEFAULT_SKILLS_OWNER = 'limrun-inc';
export const DEFAULT_SKILLS_REPO = 'skills';
export const DEFAULT_SKILLS_REF = 'main';

interface CatalogFile {
  schemaVersion: number;
  skills: Array<{
    name: string;
    defaultSelected: boolean;
  }>;
}

interface GitHubCommitResponse {
  sha: string;
}

interface GitHubTreeResponse {
  tree: Array<{
    path?: string;
    type?: string;
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
  fetchImpl?: typeof fetch;
}

export class RemoteSkillsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteSkillsError';
  }
}

function githubApiHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': '@limrun/cli',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RemoteSkillsError(`${label} must be a non-empty string`);
  }
}

function encodeRawPath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function assertOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;

  const body = await readErrorBody(response);
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  const rateLimitSuffix =
    remaining === '0' ?
      ` GitHub API rate limit exhausted${reset ? `; resets at ${new Date(Number(reset) * 1000).toISOString()}` : ''}.`
    : '';
  const detail = body ? `: ${body.slice(0, 500)}` : '';
  throw new RemoteSkillsError(`${operation} failed with HTTP ${response.status}.${rateLimitSuffix}${detail}`);
}

async function fetchJson<T>(url: string, operation: string, fetchImpl: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: githubApiHeaders() });
  } catch (err) {
    throw new RemoteSkillsError(`${operation} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await assertOk(response, operation);
  return (await response.json()) as T;
}

async function fetchText(url: string, operation: string, fetchImpl: typeof fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { 'User-Agent': '@limrun/cli' } });
  } catch (err) {
    throw new RemoteSkillsError(`${operation} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await assertOk(response, operation);
  return response.text();
}

async function fetchBuffer(url: string, operation: string, fetchImpl: typeof fetch): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { 'User-Agent': '@limrun/cli' } });
  } catch (err) {
    throw new RemoteSkillsError(`${operation} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await assertOk(response, operation);
  return Buffer.from(await response.arrayBuffer());
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
  assertString(parsed.description, `skills/${skillName}/SKILL.md frontmatter description`);
  if (parsed.name !== skillName) {
    throw new RemoteSkillsError(`skills/${skillName}/SKILL.md frontmatter name must match directory name`);
  }

  return { name: parsed.name, description: parsed.description };
}

function relativeSkillNameFromSkillMd(filePath: string): string | undefined {
  const match = filePath.match(/^skills\/([^/]+)\/SKILL\.md$/);
  return match?.[1];
}

export async function loadRemoteSkills(options: LoadRemoteSkillsOptions = {}): Promise<LoadedRemoteSkills> {
  const owner = options.owner ?? DEFAULT_SKILLS_OWNER;
  const repo = options.repo ?? DEFAULT_SKILLS_REPO;
  const ref = options.ref ?? DEFAULT_SKILLS_REF;
  const fetchImpl = options.fetchImpl ?? fetch;

  const commitUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const commitResponse = await fetchJson<GitHubCommitResponse>(
    commitUrl,
    `Fetching ${owner}/${repo}@${ref}`,
    fetchImpl,
  );
  assertString(commitResponse.sha, 'GitHub commit sha');
  const commit = commitResponse.sha;

  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`;
  const treeResponse = await fetchJson<GitHubTreeResponse>(
    treeUrl,
    `Fetching ${owner}/${repo}@${commit} file tree`,
    fetchImpl,
  );
  if (!Array.isArray(treeResponse.tree)) {
    throw new RemoteSkillsError('GitHub tree response is missing tree array');
  }

  const filePaths = treeResponse.tree
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path as string);
  const skillMdPaths = filePaths.filter((filePath) => relativeSkillNameFromSkillMd(filePath));
  if (skillMdPaths.length === 0) {
    throw new RemoteSkillsError(`${owner}/${repo}@${commit} does not contain any skills/*/SKILL.md files`);
  }

  const rawBaseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}`;
  const catalogText = await fetchText(
    `${rawBaseUrl}/catalog.json`,
    `Fetching ${owner}/${repo}@${commit} catalog.json`,
    fetchImpl,
  );
  const catalog = parseCatalog(catalogText);
  const catalogNames = catalog.skills.map((skill) => skill.name);
  const discoveredNames = skillMdPaths.map((filePath) => relativeSkillNameFromSkillMd(filePath)!);
  const duplicateCatalogNames = catalogNames.filter((name, index) => catalogNames.indexOf(name) !== index);
  if (duplicateCatalogNames.length > 0) {
    throw new RemoteSkillsError(
      `catalog.json has duplicate skill names: ${[...new Set(duplicateCatalogNames)].join(', ')}`,
    );
  }

  const missingFromCatalog = discoveredNames.filter((name) => !catalogNames.includes(name));
  const missingFromTree = catalogNames.filter((name) => !discoveredNames.includes(name));
  if (missingFromCatalog.length > 0) {
    throw new RemoteSkillsError(`skills missing from catalog.json: ${missingFromCatalog.join(', ')}`);
  }
  if (missingFromTree.length > 0) {
    throw new RemoteSkillsError(`catalog.json entries missing from skills/: ${missingFromTree.join(', ')}`);
  }
  if (!catalog.skills.some((skill) => skill.defaultSelected)) {
    throw new RemoteSkillsError('catalog.json must mark at least one skill as defaultSelected');
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-skills-'));
  const skillsRoot = path.join(rootDir, 'skills');
  try {
    const skillDirPrefixes = new Set(catalogNames.map((name) => `skills/${name}/`));
    const filesToDownload = filePaths.filter((filePath) =>
      [...skillDirPrefixes].some((prefix) => filePath.startsWith(prefix)),
    );

    await Promise.all(
      filesToDownload.map(async (filePath) => {
        const content = await fetchBuffer(
          `${rawBaseUrl}/${encodeRawPath(filePath)}`,
          `Fetching ${owner}/${repo}@${commit} ${filePath}`,
          fetchImpl,
        );
        const targetPath = path.join(rootDir, filePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content);
      }),
    );

    const skills = catalog.skills.map((catalogSkill) => {
      const skillMdPath = path.join(skillsRoot, catalogSkill.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) {
        throw new RemoteSkillsError(`Downloaded skill is missing skills/${catalogSkill.name}/SKILL.md`);
      }
      const frontmatter = parseSkillFrontmatter(catalogSkill.name, fs.readFileSync(skillMdPath, 'utf8'));
      return {
        name: frontmatter.name,
        description: frontmatter.description,
        defaultSelected: catalogSkill.defaultSelected,
        sourceDir: path.join(skillsRoot, catalogSkill.name),
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
      cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
    };
  } catch (err) {
    fs.rmSync(rootDir, { recursive: true, force: true });
    throw err;
  }
}
