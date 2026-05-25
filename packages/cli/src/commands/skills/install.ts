import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import { Command, Flags } from '@oclif/core';
import {
  AGENTS,
  AGENT_IDS,
  type AgentId,
  type AgentSpec,
  type Scope,
  targetSkillDir,
  planSkillDirectoryCopy,
  applySkillDirectoryCopy,
} from '../../lib/skills';
import { loadRemoteSkills, type LoadedRemoteSkills, type RemoteSkill } from '../../lib/remote-skills';

type SkillName = string;
const SKIPPED_REASON_CONFLICT = 'existing skill directory differs; re-run with --force to overwrite';
const SKIPPED_REASON_BLOCKED = 'blocked: another target requires --force to proceed';
const SKIPPED_REASON_DECLINED = 'user declined overwrite confirmation';

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

function createPromptCursorTracker(itemCount: number): {
  current(): number;
  onKeypress(_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }): void;
} {
  let cursor = 0;
  return {
    current: () => cursor,
    onKeypress: (_str, key) => {
      if (!key || !key.name || itemCount === 0) return;
      if (key.meta && key.name !== 'escape') return;
      const last = itemCount - 1;
      if (key.ctrl) {
        if (key.name === 'a') cursor = 0;
        else if (key.name === 'e') cursor = last;
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        cursor = cursor === 0 ? last : cursor - 1;
      } else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') {
        cursor = cursor === last ? 0 : cursor + 1;
      }
    },
  };
}

function wrapDescription(value: string, width: number, indentSize = 2): string {
  const indent = ' '.repeat(indentSize);
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = indent;
  for (const word of words) {
    if (line === indent) {
      line += word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = `${indent}${word}`;
    }
  }
  if (line !== indent) {
    lines.push(line);
  }
  return lines.join('\n');
}

function installCompactMultiselectDescriptionRenderer(): () => void {
  // prompts only exposes description text through its default renderer, whose
  // wrap indent is too deep for long skill descriptions. Patch just this prompt
  // and restore immediately after it completes.
  const MultiselectPrompt = require('prompts/lib/elements/multiselect');
  const color = require('kleur');
  const { figures } = require('prompts/lib/util');
  const originalRenderOption = MultiselectPrompt.prototype.renderOption;

  MultiselectPrompt.prototype.renderOption = function renderOption(
    this: { out: { columns?: number } },
    cursor: number,
    choice: { disabled?: boolean; selected?: boolean; title: string; description?: string },
    index: number,
    arrowIndicator: string,
  ): string {
    const prefix =
      (choice.selected ? color.green(figures.radioOn) : figures.radioOff) + ' ' + arrowIndicator + ' ';
    let title: string;

    if (choice.disabled) {
      title =
        cursor === index ? color.gray().underline(choice.title) : color.strikethrough().gray(choice.title);
    } else {
      title = cursor === index ? color.cyan().underline(choice.title) : choice.title;
    }

    const description =
      !choice.disabled && cursor === index && choice.description ?
        `\n${wrapDescription(choice.description, this.out.columns ?? 100, 4)}`
      : '';
    return prefix + title + color.gray(description);
  };

  return () => {
    MultiselectPrompt.prototype.renderOption = originalRenderOption;
  };
}

class PromptCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'PromptCancelled';
  }
}

function detectAgentsForScope(scope: Scope): Set<AgentId> {
  const detected = new Set<AgentId>();
  for (const id of AGENT_IDS) {
    const agent = AGENTS[id];
    for (const p of agent.detectionPaths(scope)) {
      if (fs.existsSync(p)) {
        detected.add(id);
        break;
      }
    }
  }
  return detected;
}

async function promptAgents(preselected: Set<AgentId>): Promise<AgentId[]> {
  const cursor = createPromptCursorTracker(AGENT_IDS.length);
  process.stdin.on('keypress', cursor.onKeypress);
  let response;
  try {
    response = await prompts(
      {
        type: 'multiselect',
        name: 'agents',
        message: 'Which agents do you want to set up?',
        instructions: false,
        choices: AGENT_IDS.map((id) => ({
          title: AGENTS[id].displayName,
          value: id,
          selected: preselected.has(id),
        })),
        hint: 'Space to toggle, Enter to confirm (Enter alone picks the highlighted agent)',
      },
      {
        onCancel: () => {
          throw new PromptCancelled();
        },
      },
    );
  } finally {
    process.stdin.off('keypress', cursor.onKeypress);
  }

  let picked = (response.agents ?? []) as AgentId[];
  const highlightedAgent = AGENT_IDS[cursor.current()];
  if (picked.length === 0 && highlightedAgent) {
    picked = [highlightedAgent];
  }
  process.stderr.write(`  Selected: ${picked.map((id) => AGENTS[id].displayName).join(', ')}\n`);
  return picked;
}

async function promptSkills(availableSkills: RemoteSkill[]): Promise<SkillName[]> {
  const cursor = createPromptCursorTracker(availableSkills.length);
  let response;
  const restoreMultiselectRenderer = installCompactMultiselectDescriptionRenderer();
  process.stdin.on('keypress', cursor.onKeypress);
  try {
    response = await prompts(
      {
        type: 'multiselect',
        name: 'skills',
        message: 'Which Limrun skills do you want to install?',
        instructions: false,
        choices: availableSkills.map((skill) => ({
          title: skill.name,
          description: skill.description.replace(/\s+/g, ' ').trim(),
          value: skill.name,
          selected: skill.defaultSelected,
        })),
        hint: 'Catalog defaults selected. Space toggles, Enter confirms.',
      },
      {
        onCancel: () => {
          throw new PromptCancelled();
        },
      },
    );
  } finally {
    restoreMultiselectRenderer();
    process.stdin.off('keypress', cursor.onKeypress);
  }

  let picked = uniqueSkillNames((response.skills ?? []) as string[], availableSkills);
  const highlightedSkill = availableSkills[cursor.current()];
  if (picked.length === 0 && highlightedSkill) {
    picked = [highlightedSkill.name];
  }
  process.stderr.write(`  Selected skills: ${picked.join(', ')}\n`);
  return picked;
}

async function promptScope(): Promise<Scope> {
  const response = await prompts(
    {
      type: 'select',
      name: 'scope',
      message: 'Install location?',
      choices: [
        { title: 'Project', value: 'project', description: 'Install into the current directory' },
        { title: 'Global', value: 'global', description: 'Install into your home directory' },
      ],
      initial: 0,
    },
    {
      onCancel: () => {
        throw new PromptCancelled();
      },
    },
  );
  return response.scope as Scope;
}

async function promptOverwrite(targetPath: string): Promise<boolean> {
  const response = await prompts(
    {
      type: 'confirm',
      name: 'ok',
      message: `Overwrite existing ${targetPath}?`,
      initial: false,
    },
    {
      onCancel: () => {
        throw new PromptCancelled();
      },
    },
  );
  return Boolean(response.ok);
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
    'Fetch the latest Limrun skills from limrun-inc/skills and install them into the native skills directory for each selected agent (Claude Code, Cursor, Codex). Pre-checks detected agents and lets you pick project or global scope.';
  static examples = [
    '<%= config.bin %> skills install',
    '<%= config.bin %> skills install --agents claude --agents cursor --scope project',
    '<%= config.bin %> skills install --agents cursor --scope project --skills limrun-xcode-and-ios-simulator --skills limrun-detox-testing',
    '<%= config.bin %> skills install --agents codex --scope global --force',
  ];
  static flags = {
    agents: Flags.string({
      description: 'Target agent. Repeat to pick multiple.',
      multiple: true,
      options: AGENT_IDS,
    }),
    skills: Flags.string({
      description:
        'Limrun skill to install. Repeat to pick multiple. Defaults to the remote catalog default.',
      multiple: true,
    }),
    scope: Flags.string({
      description: 'Install scope.',
      options: ['project', 'global'],
    }),
    force: Flags.boolean({
      description: 'Overwrite existing skill directories without confirmation.',
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
    try {
      await this.runInner();
    } catch (err) {
      if (err instanceof PromptCancelled) {
        this.exit(130);
      }
      throw err;
    }
  }

  private async runInner(): Promise<void> {
    const { flags } = await this.parse(SkillsInstall);

    const interactive = process.stdin.isTTY === true && !flags.json && !flags.quiet;

    let agents: AgentId[];
    let skills: SkillName[] = [];
    let scope: Scope;
    let source: LoadedRemoteSkills | undefined;

    try {
      if (!interactive) {
        if (!flags.agents || flags.agents.length === 0) {
          this.error(`--agents requires at least one of: ${AGENT_IDS.join(', ')}.`, { exit: 2 });
        }
        if (!flags.scope) {
          this.error('Specify --agents and --scope in non-interactive mode.', { exit: 2 });
        }
      }

      if (interactive) {
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
      } else if (interactive) {
        skills = await promptSkills(availableSkills);
      } else {
        skills = availableSkills.filter((skill) => skill.defaultSelected).map((skill) => skill.name);
      }

      if (skills.length === 0) {
        this.error(`No default Limrun skills found in ${source.owner}/${source.repo}@${source.commit}.`, {
          exit: 1,
        });
      }

      if (flags.agents && flags.agents.length > 0) {
        agents = Array.from(new Set(flags.agents)) as AgentId[];
      } else if (interactive) {
        // Pre-check based on project-local presence only. Global installs of
        // agents (e.g. ~/.claude on a dev machine) are too weak a signal to
        // auto-select them for this specific project's install.
        agents = await promptAgents(detectAgentsForScope('project'));
      } else {
        this.error(`--agents requires at least one of: ${AGENT_IDS.join(', ')}.`, { exit: 2 });
      }

      if (flags.scope) {
        scope = flags.scope as Scope;
      } else if (interactive) {
        scope = await promptScope();
      } else {
        this.error('Specify --agents and --scope in non-interactive mode.', { exit: 2 });
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

      // Phase 2: Confirm.
      const results: ResultRow[] = [];
      const anyConflict = planned.some((t) => t.kind === 'conflict');

      if (anyConflict && !flags.force && !interactive) {
        // Non-interactive + conflict + no force: all-or-nothing. Skip all targets.
        for (const t of planned) {
          results.push({
            skill: t.skill,
            agent: t.agent.id,
            scope: t.scope,
            path: t.target,
            status: 'skipped',
            reason: t.kind === 'conflict' ? SKIPPED_REASON_CONFLICT : SKIPPED_REASON_BLOCKED,
          });
        }
        if (!flags.json) {
          // --quiet still suppresses the human summary, but a hard refusal needs to be visible.
          process.stderr.write(
            'Existing skill directories would be overwritten. Re-run with --force, or run interactively to confirm per target.\n',
          );
        }
        this.emitOutput(results, flags, skills, source);
        this.exit(1);
      }

      // Decide final status per target (no writes yet).
      const finalDecisions: Array<{ target: PlannedTarget; status: Status; reason?: string }> = [];
      for (const t of planned) {
        if (t.kind === 'install') {
          finalDecisions.push({ target: t, status: 'installed' });
        } else if (t.kind === 'unchanged') {
          finalDecisions.push({ target: t, status: 'unchanged' });
        } else if (flags.force) {
          finalDecisions.push({ target: t, status: 'updated' });
        } else {
          // Interactive conflict without --force: prompt per target.
          const displayPath = humanPath(t.target, t.scope);
          const ok = await promptOverwrite(displayPath);
          if (ok) {
            finalDecisions.push({ target: t, status: 'updated' });
          } else {
            finalDecisions.push({
              target: t,
              status: 'skipped',
              reason: SKIPPED_REASON_DECLINED,
            });
          }
        }
      }

      // Phase 3: Apply.
      for (const decision of finalDecisions) {
        if (decision.status === 'installed' || decision.status === 'updated') {
          applySkillDirectoryCopy(decision.target.source, decision.target.target);
        }
        results.push({
          skill: decision.target.skill,
          agent: decision.target.agent.id,
          scope: decision.target.scope,
          path: decision.target.target,
          status: decision.status,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
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
