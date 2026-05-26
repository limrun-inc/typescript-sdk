import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { readConfig } from './config';
import {
  AGENTS,
  applySkillDirectoryCopy,
  planSkillDirectoryCopy,
  targetSkillDir,
  type AgentId,
  type PlanKind,
} from './skills';
import { loadRemoteSkills, type LoadedRemoteSkills } from './remote-skills';

const execFileAsync = promisify(execFile);

export const SAMPLE_NATIVE_APP_REPO = 'https://github.com/limrun-inc/sample-native-app';
export const SAMPLE_NATIVE_APP_DIR = 'sample-native-app';

const SAMPLE_CLONE_TIMEOUT_MS = 300_000;

type OnboardingAgent = Extract<AgentId, 'claude' | 'cursor'>;
type SkillStatus = 'installed' | 'unchanged' | 'skipped';
const ONBOARDING_AGENTS: OnboardingAgent[] = ['cursor', 'claude'];

export interface SkillInstallResult {
  skill: string;
  agent: OnboardingAgent;
  path: string;
  status: SkillStatus;
}

interface EnsureLoggedInOptions {
  version: string;
  apiKey?: string;
  log?: (message: string) => void;
}

interface InstallProjectSkillsOptions {
  projectRoot: string;
  skillNames: string[];
  source?: LoadedRemoteSkills;
}

type GitRunner = (args: string[], cwd?: string) => Promise<string>;

interface SampleRepoOptions {
  cwd: string;
  git?: GitRunner;
}

const ENV_API_KEY_RE = /^\s*(?:export\s+)?LIM_API_KEY\s*=/;

class OnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingError';
  }
}

export async function ensureLoggedIn({ version, apiKey, log }: EnsureLoggedInOptions): Promise<void> {
  if (apiKey) {
    return;
  }
  const config = readConfig();
  if (config.apiKey) {
    return;
  }
  log?.('Opening browser for Limrun login...');
  const { login } = await import('./auth');
  await login(config.consoleEndpoint, version);
  log?.('Logged in to Limrun.');
}

export function ensureProjectEnvApiKey(projectRoot: string, apiKey: string): void {
  if (!apiKey) {
    throw new OnboardingError('Limrun API key is missing after login. Run `lim login`, then rerun `lim go`.');
  }
  if (/[\r\n]/.test(apiKey)) {
    throw new OnboardingError('Limrun API key contains an invalid newline.');
  }

  const envPath = path.join(projectRoot, '.env');
  const apiKeyLine = `LIM_API_KEY=${apiKey}`;
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${apiKeyLine}\n`, { mode: 0o600 });
    return;
  }

  const existing = fs.readFileSync(envPath, 'utf8');
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const nextLines: string[] = [];
  for (const line of lines) {
    if (ENV_API_KEY_RE.test(line)) {
      if (!replaced) {
        nextLines.push(apiKeyLine);
        replaced = true;
      }
      continue;
    }
    nextLines.push(line);
  }

  if (!replaced) {
    const hasTrailingNewline = existing.endsWith('\n');
    if (existing.length === 0) {
      nextLines.push(apiKeyLine);
    } else if (hasTrailingNewline) {
      nextLines.splice(nextLines.length - 1, 0, apiKeyLine);
    } else {
      nextLines.push(apiKeyLine);
    }
  }

  const next = nextLines.join('\n');
  if (next !== existing) {
    fs.writeFileSync(envPath, next);
  }
}

export async function installProjectSkills({
  projectRoot,
  skillNames,
  source,
}: InstallProjectSkillsOptions): Promise<SkillInstallResult[]> {
  const loaded = source ?? (await loadRemoteSkills());
  const shouldCleanup = source === undefined;
  try {
    const results: SkillInstallResult[] = [];
    for (const skillName of skillNames) {
      const skill = loaded.skills.find((candidate) => candidate.name === skillName);
      if (!skill) {
        throw new OnboardingError(`Limrun skill "${skillName}" was not found in ${loaded.owner}/${loaded.repo}.`);
      }

      for (const agent of ONBOARDING_AGENTS) {
        const target = targetSkillDir(AGENTS[agent], 'project', skillName, projectRoot);
        const { kind } = planSkillDirectoryCopy(skill.sourceDir, target);
        const status = applySkillDecision(kind, skill.sourceDir, target);
        results.push({
          skill: skillName,
          agent,
          path: target,
          status,
        });
      }
    }
    return results;
  } finally {
    if (shouldCleanup) {
      loaded.cleanup();
    }
  }
}

function applySkillDecision(kind: PlanKind, sourceDir: string, targetDir: string): SkillStatus {
  if (kind === 'unchanged') {
    return 'unchanged';
  }
  if (kind === 'conflict') {
    return 'skipped';
  }
  applySkillDirectoryCopy(sourceDir, targetDir);
  return 'installed';
}

function normalizeGitRemote(remote: string): string {
  let value = remote.trim();
  const sshMatch = value.match(/^git@github\.com:(.+)$/i);
  if (sshMatch) {
    value = `https://github.com/${sshMatch[1]}`;
  }
  const sshUrlMatch = value.match(/^ssh:\/\/git@github\.com\/(.+)$/i);
  if (sshUrlMatch) {
    value = `https://github.com/${sshUrlMatch[1]}`;
  }
  value = value.replace(/\.git$/i, '').replace(/\/+$/g, '');
  return value.toLowerCase();
}

function isExpectedSampleRemote(remote: string): boolean {
  return normalizeGitRemote(remote) === normalizeGitRemote(SAMPLE_NATIVE_APP_REPO);
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: SAMPLE_CLONE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') {
      throw new OnboardingError('Git is required to fetch the sample app. Install git, then rerun `lim go`.');
    }
    throw err;
  }
}

async function verifySampleRemote(sampleDir: string, git: GitRunner): Promise<void> {
  let remote: string;
  try {
    remote = await git(['remote', 'get-url', 'origin'], sampleDir);
  } catch (err) {
    if (err instanceof OnboardingError) throw err;
    throw new OnboardingError(
      `${sampleDir} already exists but is not a git checkout of ${SAMPLE_NATIVE_APP_REPO}. Move or delete it, then rerun \`lim go\`.`,
    );
  }
  if (!isExpectedSampleRemote(remote)) {
    throw new OnboardingError(
      `${sampleDir} already exists with origin ${remote}. Move or delete it, then rerun \`lim go\`.`,
    );
  }
}

export async function ensureSampleRepo({
  cwd,
  git = runGit,
}: SampleRepoOptions): Promise<{ path: string; reused: boolean }> {
  const sampleDir = path.join(cwd, SAMPLE_NATIVE_APP_DIR);
  if (fs.existsSync(sampleDir)) {
    if (!fs.lstatSync(sampleDir).isDirectory()) {
      throw new OnboardingError(
        `${sampleDir} already exists and is not a directory. Move or delete it, then rerun \`lim go\`.`,
      );
    }
    await verifySampleRemote(sampleDir, git);
    return { path: sampleDir, reused: true };
  }

  await git(['clone', '--depth', '1', SAMPLE_NATIVE_APP_REPO, SAMPLE_NATIVE_APP_DIR], cwd);
  return { path: sampleDir, reused: false };
}

export { OnboardingError };
