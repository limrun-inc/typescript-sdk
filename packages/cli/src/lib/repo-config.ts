import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Repo-checked build configuration read from `limrun.yaml` at the sync root.
 * Explicit CLI flags override these per field.
 */
export interface RepoConfig {
  project?: string;
  workspace?: string;
  scheme?: string;
  prepare?: string[];
}

export const REPO_CONFIG_FILENAME = 'limrun.yaml';

function invalid(field: string, expectation: string): Error {
  return new Error(`${REPO_CONFIG_FILENAME}: '${field}' must be ${expectation}`);
}

function optionalString(raw: Record<string, unknown>, field: keyof RepoConfig & string): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(field, 'a non-empty string');
  }
  return value;
}

/**
 * Reads limrun.yaml from the sync root. Returns undefined when the file does
 * not exist. Unknown keys are ignored for forward compatibility; known keys
 * with the wrong shape fail loudly rather than being silently dropped.
 */
export function readRepoConfig(syncRoot: string): RepoConfig | undefined {
  const file = path.join(syncRoot, REPO_CONFIG_FILENAME);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
  if (parsed === undefined || parsed === null) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${REPO_CONFIG_FILENAME}: expected a mapping of configuration keys`);
  }
  const raw = parsed as Record<string, unknown>;

  const config: RepoConfig = {};
  const project = optionalString(raw, 'project');
  const workspace = optionalString(raw, 'workspace');
  const scheme = optionalString(raw, 'scheme');
  if (project !== undefined) config.project = project;
  if (workspace !== undefined) config.workspace = workspace;
  if (scheme !== undefined) config.scheme = scheme;
  if (config.project && config.workspace) {
    throw new Error(`${REPO_CONFIG_FILENAME}: set either 'project' or 'workspace', not both`);
  }
  if (raw['prepare'] !== undefined && raw['prepare'] !== null) {
    const prepare = raw['prepare'];
    if (!Array.isArray(prepare) || prepare.some((cmd) => typeof cmd !== 'string' || cmd.trim() === '')) {
      throw invalid('prepare', 'a list of non-empty strings');
    }
    config.prepare = prepare as string[];
  }
  return config;
}
