import fs from 'fs';
import path from 'path';
import os from 'os';

export type AgentId = 'claude' | 'cursor' | 'codex';
export type Scope = 'project' | 'global';

export const AGENT_IDS: AgentId[] = ['claude', 'cursor', 'codex'];

export interface AgentSpec {
  id: AgentId;
  displayName: string;
  skillsDir(scope: Scope): string;
  detectionPaths(scope: Scope): string[];
}

function claudeGlobalRoot(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.claude');
}

function codexGlobalRoot(): string {
  const override = process.env.CODEX_HOME;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.codex');
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    skillsDir: (scope) =>
      scope === 'project' ?
        path.join(process.cwd(), '.claude', 'skills')
      : path.join(claudeGlobalRoot(), 'skills'),
    detectionPaths: (scope) =>
      scope === 'project' ? [path.join(process.cwd(), '.claude')] : [claudeGlobalRoot()],
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    // Cursor auto-discovers .agents/skills/ natively, same as .cursor/skills/.
    // Installing into .agents/skills/ also reaches OpenCode and any other
    // AGENTS.md-aware tool with a single copy, so prefer the broader path.
    skillsDir: (scope) =>
      scope === 'project' ?
        path.join(process.cwd(), '.agents', 'skills')
      : path.join(os.homedir(), '.agents', 'skills'),
    // Detect either .cursor/ or .agents/: both are reliable signs the user
    // is on a tool that auto-loads .agents/skills/.
    detectionPaths: (scope) =>
      scope === 'project' ?
        [path.join(process.cwd(), '.cursor'), path.join(process.cwd(), '.agents')]
      : [path.join(os.homedir(), '.cursor'), path.join(os.homedir(), '.agents')],
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    skillsDir: (scope) =>
      scope === 'project' ?
        path.join(process.cwd(), '.codex', 'skills')
      : path.join(codexGlobalRoot(), 'skills'),
    detectionPaths: (scope) =>
      scope === 'project' ? [path.join(process.cwd(), '.codex')] : [codexGlobalRoot()],
  },
};

export function sourceSkillDir(skillsRoot: string, skillName: string): string {
  return path.join(skillsRoot, skillName);
}

export function sourceSkillMd(skillsRoot: string, skillName: string): string {
  return path.join(sourceSkillDir(skillsRoot, skillName), 'SKILL.md');
}

export function targetSkillDir(agent: AgentSpec, scope: Scope, skillName: string): string {
  return path.join(agent.skillsDir(scope), skillName);
}

export function targetSkillMd(agent: AgentSpec, scope: Scope, skillName: string): string {
  return path.join(targetSkillDir(agent, scope, skillName), 'SKILL.md');
}

export type PlanKind = 'install' | 'unchanged' | 'conflict';

function listRelativeFiles(root: string): string[] {
  const files: string[] = [];

  function walk(current: string, relativePrefix: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relativePath = path.join(relativePrefix, entry.name);
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walk(root, '');
  return files.sort();
}

function directoriesEqual(sourceDir: string, targetDir: string): boolean {
  const sourceFiles = listRelativeFiles(sourceDir);
  const targetFiles = listRelativeFiles(targetDir);
  if (sourceFiles.length !== targetFiles.length) return false;

  for (let i = 0; i < sourceFiles.length; i += 1) {
    if (sourceFiles[i] !== targetFiles[i]) return false;

    const sourcePath = path.join(sourceDir, sourceFiles[i]);
    const targetPath = path.join(targetDir, targetFiles[i]);
    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.statSync(targetPath);
    if (!sourceStat.isFile() || !targetStat.isFile()) return false;

    const sourceBuf = fs.readFileSync(sourcePath);
    const targetBuf = fs.readFileSync(targetPath);
    if (!sourceBuf.equals(targetBuf)) return false;
  }

  return true;
}

export function planSkillDirectoryCopy(sourceDir: string, targetDir: string): { kind: PlanKind } {
  if (!fs.existsSync(targetDir)) {
    return { kind: 'install' };
  }
  if (!fs.statSync(targetDir).isDirectory()) {
    return { kind: 'conflict' };
  }
  return { kind: directoriesEqual(sourceDir, targetDir) ? 'unchanged' : 'conflict' };
}

export function applySkillDirectoryCopy(sourceDir: string, targetDir: string): void {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}
