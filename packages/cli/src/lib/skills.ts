import fs from 'fs';
import path from 'path';
import os from 'os';
import { type Config } from '@oclif/core';

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

export function skillsRoot(config: Config): string {
  return path.join(config.root, 'skills');
}

export function sourceSkillMd(config: Config, skillName: string): string {
  return path.join(skillsRoot(config), skillName, 'SKILL.md');
}

export function targetSkillMd(agent: AgentSpec, scope: Scope, skillName: string): string {
  return path.join(agent.skillsDir(scope), skillName, 'SKILL.md');
}

export type PlanKind = 'install' | 'unchanged' | 'conflict';

export function planSkillFileCopy(sourceFile: string, targetFile: string): { kind: PlanKind } {
  if (!fs.existsSync(targetFile)) {
    return { kind: 'install' };
  }
  const sourceBuf = fs.readFileSync(sourceFile);
  const targetBuf = fs.readFileSync(targetFile);
  return { kind: sourceBuf.equals(targetBuf) ? 'unchanged' : 'conflict' };
}

export function applySkillFileCopy(sourceFile: string, targetFile: string): void {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);
}
