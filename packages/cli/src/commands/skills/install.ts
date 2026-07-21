import fs from 'fs';
import path from 'path';
import { Command, Flags } from '@oclif/core';
import {
  AGENTS,
  AGENT_IDS,
  detectAdoptedAgents,
  selectDefaultSkills,
  type AgentId,
  type AgentSpec,
  type Scope,
  targetSkillDir,
  planSkillDirectoryCopy,
  applySkillDirectoryCopy,
} from '../../lib/skills';
import { scanSkillHints } from '../../lib/project-detection';
import { loadRemoteSkills, type LoadedRemoteSkills, type RemoteSkill } from '../../lib/remote-skills';

type SkillName = string;
const SKIPPED_REASON_KEPT = 'existing skill directory differs; kept because --keep-existing was passed';

type Status = 'installed' | 'updated' | 'unchanged' | 'skipped';

interface PlannedTarget {
  skill: SkillName;
  agent: AgentSpec;
  scope: Scope;
  source: string;
  target: string;
  kind: 'install' | 'unchanged' | 'conflict';
}

interface ResultRow {
  skill: SkillName;
  agent: AgentId;
  scope: Scope;
  path: string;
  status: Status;
  reason?: string;
}

function uniqueSkillNames(values: string[], availableSkills: RemoteSkill[]): SkillName[] {
  const validNames = availableSkills.map((skill) => skill.name);
  const skills: SkillName[] = [];
  for (const value of values) {
    if (!validNames.includes(value)) {
      throw new Error(`Unknown skill "${value}". Valid skills: ${validNames.join(', ')}`);
    }
    if (!skills.includes(value)) {
      skills.push(value);
    }
  }
  return skills;
}

function humanPath(absolutePath: string, scope: Scope): string {
  if (scope !== 'project') {
    return absolutePath;
  }
  const relative = path.relative(process.cwd(), absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
}

function statusLabel(status: Status): string {
  switch (status) {
    case 'installed':
      return 'Installed';
    case 'updated':
      return 'Updated';
    case 'unchanged':
      return 'Unchanged';
    case 'skipped':
      return 'Skipped';
  }
}

export default class SkillsInstall extends Command {
  static summary = 'Install Limrun skills for AI coding agents';
  static description =
    'Fetch the latest Limrun skills from limrun-inc/skills and install them into the native skills directory for each agent (Claude Code, Cursor, Codex). By default all skills are installed for all agents; Expo and Bazel skills are only included when the folder scan finds matching clues, and an existing skills structure (e.g. .claude/skills/) is adopted instead of creating directories for every agent. Existing skill directories with different content are updated in place; review the change in your VCS diff, or pass --keep-existing to leave them untouched.';
  static examples = [
    '<%= config.bin %> skills install',
    '<%= config.bin %> skills install --agents claude --agents cursor',
    '<%= config.bin %> skills install --agents cursor --skills limrun-xcode --skills limrun-ios-simulator',
    '<%= config.bin %> skills install --keep-existing',
    '<%= config.bin %> skills install --agents codex --scope global',
  ];
  static flags = {
    agents: Flags.string({
      description:
        'Target agent. Repeat to pick multiple. Defaults to agents with an existing skills directory, or all agents when none exists.',
      multiple: true,
      options: AGENT_IDS,
    }),
    skills: Flags.string({
      description:
        'Limrun skill to install. Repeat to pick multiple. Defaults to all skills, with Expo/Bazel skills included only when the folder scan finds matching clues.',
      multiple: true,
    }),
    scope: Flags.string({
      description: 'Install scope.',
      options: ['project', 'global'],
      default: 'project',
    }),
    'keep-existing': Flags.boolean({
      description: 'Keep existing skill directories that differ from the fetched version instead of updating them.',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Emit structured JSON output.',
      default: false,
    }),
    quiet: Flags.boolean({
      description: 'Suppress non-result output.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SkillsInstall);

    const verbose = !flags.json && !flags.quiet;
    const scope = flags.scope as Scope;

    let skills: SkillName[] = [];
    let source: LoadedRemoteSkills | undefined;

    try {
      if (verbose) {
        process.stderr.write('Fetching latest Limrun skills...\n');
      }
      source = await loadRemoteSkills();
      const availableSkills = source.skills;
      if (availableSkills.length === 0) {
        this.error(`No Limrun skills found in ${source.owner}/${source.repo}@${source.commit}.`, {
          exit: 1,
        });
      }

      if (flags.skills && flags.skills.length > 0) {
        skills = uniqueSkillNames(flags.skills, availableSkills);
      } else {
        const hints = scanSkillHints(process.cwd());
        const selection = selectDefaultSkills(
          availableSkills.map((skill) => skill.name),
          hints,
        );
        skills = selection.selected;
        if (verbose) {
          for (const excluded of selection.excluded) {
            process.stderr.write(`Skipping ${excluded.name}: ${excluded.reason}.\n`);
          }
        }
      }

      if (skills.length === 0) {
        this.error(`No Limrun skills found in ${source.owner}/${source.repo}@${source.commit}.`, {
          exit: 1,
        });
      }

      let agents: AgentId[];
      if (flags.agents && flags.agents.length > 0) {
        agents = Array.from(new Set(flags.agents)) as AgentId[];
      } else {
        const adopted = detectAdoptedAgents(scope);
        if (adopted.length > 0) {
          agents = adopted;
          if (verbose) {
            process.stderr.write(
              `Found existing skills structure for ${adopted
                .map((id) => AGENTS[id].displayName)
                .join(', ')}; installing only there.\n`,
            );
          }
        } else {
          agents = [...AGENT_IDS];
        }
      }

      const sources = new Map<SkillName, string>();
      for (const skill of skills) {
        const sourceSkill = availableSkills.find((availableSkill) => availableSkill.name === skill);
        if (!sourceSkill || !fs.existsSync(sourceSkill.sourceDir)) {
          this.error(`Fetched skill source missing for "${skill}".`, { exit: 1 });
        }
        sources.set(skill, sourceSkill.sourceDir);
      }

      // Phase 1: Plan.
      const planned: PlannedTarget[] = [];
      for (const skill of skills) {
        const sourceDir = sources.get(skill)!;
        for (const id of agents) {
          const agent = AGENTS[id];
          const target = targetSkillDir(agent, scope, skill);
          const { kind } = planSkillDirectoryCopy(sourceDir, target);
          planned.push({ skill, agent, scope, source: sourceDir, target, kind });
        }
      }

      // Phase 2: Apply. Differing targets are updated in place by default so
      // installs always converge on the latest fetched skills; the previous
      // content stays reviewable in the user's VCS diff. --keep-existing opts
      // out and leaves differing directories untouched.
      const results: ResultRow[] = [];
      let anyUpdated = false;
      for (const t of planned) {
        let status: Status;
        let reason: string | undefined;
        if (t.kind === 'unchanged') {
          status = 'unchanged';
        } else if (t.kind === 'conflict' && flags['keep-existing']) {
          status = 'skipped';
          reason = SKIPPED_REASON_KEPT;
        } else {
          applySkillDirectoryCopy(t.source, t.target);
          status = t.kind === 'conflict' ? 'updated' : 'installed';
          anyUpdated = anyUpdated || status === 'updated';
        }
        results.push({
          skill: t.skill,
          agent: t.agent.id,
          scope: t.scope,
          path: t.target,
          status,
          ...(reason ? { reason } : {}),
        });
      }

      if (verbose && anyUpdated) {
        process.stderr.write(
          'Updated skill directories that had local changes. Review the diff in version control and ask your agent to reconcile if needed, or re-run with --keep-existing to leave them untouched.\n',
        );
      }

      this.emitOutput(results, flags, skills, source);
    } finally {
      source?.cleanup();
    }
  }

  private emitOutput(
    results: ResultRow[],
    flags: { json: boolean; quiet: boolean },
    skills: SkillName[],
    source: LoadedRemoteSkills,
  ): void {
    if (flags.json) {
      this.log(
        JSON.stringify(
          {
            ...(skills.length === 1 ? { skill: skills[0] } : {}),
            skills,
            source: {
              repository: `${source.owner}/${source.repo}`,
              ref: source.ref,
              commit: source.commit,
            },
            results,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (flags.quiet) {
      return;
    }

    // Human summary.
    this.log('');
    this.log('  Limrun skills');
    const skillColWidth = Math.max(...results.map((r) => r.skill.length), 'Skill'.length);
    const agentColWidth = Math.max(
      ...results.map((r) => AGENTS[r.agent].displayName.length),
      'Claude Code'.length,
    );
    for (const r of results) {
      const skillLabel = r.skill.padEnd(skillColWidth);
      const agentLabel = AGENTS[r.agent].displayName.padEnd(agentColWidth);
      const displayPath = humanPath(r.path, r.scope);
      const reason = r.reason ? `  (${r.reason})` : '';
      this.log(`    ${skillLabel}  ${agentLabel}  ->  ${displayPath}    ${statusLabel(r.status)}${reason}`);
    }
    this.log('');
  }
}
