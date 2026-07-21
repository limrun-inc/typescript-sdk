import fs from 'fs';
import path from 'path';
import os from 'os';

export type AgentId = 'claude' | 'cursor' | 'codex';
export type Scope = 'project' | 'global';

export const AGENT_IDS: AgentId[] = ['claude', 'cursor', 'codex'];

export interface AgentSpec {
  id: AgentId;
  displayName: string;
  /**
   * Skills directories this agent reads, preferred location first. Installs
   * adopt the first candidate that already exists on disk so we extend an
   * existing skills structure instead of creating a parallel one.
   */
  skillsDirCandidates(scope: Scope, projectRoot?: string): string[];
}

function claudeGlobalRoot(): string {
  const override = process.env['CLAUDE_CONFIG_DIR'];
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.claude');
}

function codexGlobalRoot(): string {
  const override = process.env['CODEX_HOME'];
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.codex');
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    skillsDirCandidates: (scope, projectRoot = process.cwd()) =>
      scope === 'project' ?
        [path.join(projectRoot, '.claude', 'skills')]
      : [path.join(claudeGlobalRoot(), 'skills')],
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    // Cursor auto-discovers .agents/skills/ natively, same as .cursor/skills/.
    // Installing into .agents/skills/ also reaches OpenCode and any other
    // AGENTS.md-aware tool with a single copy, so prefer the broader path.
    // When only .cursor/skills/ already exists we adopt it instead of
    // creating a second structure.
    skillsDirCandidates: (scope, projectRoot = process.cwd()) =>
      scope === 'project' ?
        [path.join(projectRoot, '.agents', 'skills'), path.join(projectRoot, '.cursor', 'skills')]
      : [path.join(os.homedir(), '.agents', 'skills'), path.join(os.homedir(), '.cursor', 'skills')],
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    skillsDirCandidates: (scope, projectRoot = process.cwd()) =>
      scope === 'project' ?
        [path.join(projectRoot, '.codex', 'skills')]
      : [path.join(codexGlobalRoot(), 'skills')],
  },
};

function isExistingDirectory(candidatePath: string): boolean {
  try {
    return fs.lstatSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

export function resolveSkillsDir(agent: AgentSpec, scope: Scope, projectRoot?: string): string {
  const candidates = agent.skillsDirCandidates(scope, projectRoot);
  return candidates.find(isExistingDirectory) ?? candidates[0]!;
}

/**
 * Agents that already have a skills directory on disk for the given scope.
 * When any exist, installs adopt that structure instead of creating skill
 * directories for every supported agent.
 */
export function detectAdoptedAgents(scope: Scope, projectRoot?: string): AgentId[] {
  return AGENT_IDS.filter((id) =>
    AGENTS[id].skillsDirCandidates(scope, projectRoot).some(isExistingDirectory),
  );
}

export interface SkillHints {
  expo: boolean;
  bazel: boolean;
}

export interface DefaultSkillSelection {
  selected: string[];
  excluded: Array<{ name: string; reason: string }>;
}

/**
 * Default selection installs every catalog skill, except that Expo- and
 * Bazel-specific skills are only included when the project scan found
 * matching clues.
 */
export function selectDefaultSkills(skillNames: string[], hints: SkillHints): DefaultSkillSelection {
  const selected: string[] = [];
  const excluded: Array<{ name: string; reason: string }> = [];
  for (const name of skillNames) {
    const tokens = name.split('-');
    if (tokens.includes('expo') && !hints.expo) {
      excluded.push({ name, reason: 'no Expo project detected in this folder' });
    } else if (tokens.includes('bazel') && !hints.bazel) {
      excluded.push({ name, reason: 'no Bazel workspace detected in this folder' });
    } else {
      selected.push(name);
    }
  }
  return { selected, excluded };
}

export function targetSkillDir(
  agent: AgentSpec,
  scope: Scope,
  skillName: string,
  projectRoot?: string,
): string {
  return path.join(resolveSkillsDir(agent, scope, projectRoot), skillName);
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
    const sourceFile = sourceFiles[i];
    const targetFile = targetFiles[i];
    if (sourceFile === undefined || targetFile === undefined || sourceFile !== targetFile) return false;

    const sourcePath = path.join(sourceDir, sourceFile);
    const targetPath = path.join(targetDir, targetFile);
    const sourceStat = fs.lstatSync(sourcePath);
    const targetStat = fs.lstatSync(targetPath);
    if (!sourceStat.isFile() || !targetStat.isFile()) return false;
    if (sourceStat.size !== targetStat.size) return false;

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
  if (!fs.lstatSync(targetDir).isDirectory()) {
    return { kind: 'conflict' };
  }
  return { kind: directoriesEqual(sourceDir, targetDir) ? 'unchanged' : 'conflict' };
}

export function applySkillDirectoryCopy(sourceDir: string, targetDir: string): void {
  const parentDir = path.dirname(targetDir);
  const baseName = path.basename(targetDir);
  const suffix = `${process.pid}-${Date.now()}`;
  const tempDir = path.join(parentDir, `.${baseName}.tmp-${suffix}`);
  const backupDir = path.join(parentDir, `.${baseName}.backup-${suffix}`);
  let backedUp = false;
  let installed = false;

  fs.mkdirSync(parentDir, { recursive: true });

  try {
    fs.cpSync(sourceDir, tempDir, { recursive: true });

    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      backedUp = true;
    }

    fs.renameSync(tempDir, targetDir);
    installed = true;
  } catch (err) {
    if (backedUp && !installed && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      try {
        fs.renameSync(backupDir, targetDir);
        backedUp = false;
      } catch {
        // Preserve the original error; rollback failure leaves the backup for manual recovery.
      }
    }
    throw err;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (installed || !backedUp) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  }
}
