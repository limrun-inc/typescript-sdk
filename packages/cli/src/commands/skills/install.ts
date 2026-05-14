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
  sourceSkillMd,
  targetSkillMd,
  planSkillFileCopy,
  applySkillFileCopy,
} from '../../lib/skills';

const SKILL_CATALOG = [
  {
    name: 'limrun-ios',
    description: 'Build, launch, and control iOS apps with remote Xcode and Simulators',
    defaultSelected: true,
  },
  {
    name: 'limrun-detox',
    description: 'Run Detox tests on Limrun iOS with remote simulator launch and networking',
    defaultSelected: false,
  },
] as const;
type SkillName = (typeof SKILL_CATALOG)[number]['name'];
const SKILL_NAMES = SKILL_CATALOG.map((skill) => skill.name) as SkillName[];
const DEFAULT_SKILL_NAMES = SKILL_CATALOG.filter((skill) => skill.defaultSelected).map(
  (skill) => skill.name,
) as SkillName[];
const SKIPPED_REASON_CONFLICT = 'existing content differs; re-run with --force to overwrite';
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

function isSkillName(value: string): value is SkillName {
  return SKILL_NAMES.includes(value as SkillName);
}

function uniqueSkillNames(values: string[]): SkillName[] {
  const skills: SkillName[] = [];
  for (const value of values) {
    if (!isSkillName(value)) {
      throw new Error(`Unknown skill "${value}". Valid skills: ${SKILL_NAMES.join(', ')}`);
    }
    if (!skills.includes(value)) {
      skills.push(value);
    }
  }
  return skills;
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
  // Loop to enforce "at least one agent" without crashing.
  while (true) {
    // `prompts` does not expose the multiselect cursor in onState - the state
    // event only carries {value, aborted, exited}. Track cursor ourselves by
    // listening to keypress events on stdin and mirror prompts' own dispatch
    // (see prompts/lib/util/action.js and multiselect.js):
    //   - up / k  : wrap (cursor === 0 ? last : cursor - 1)
    //   - down / j / tab : wrap (cursor === last ? 0 : cursor + 1)
    //   - ctrl+a  : first
    //   - ctrl+e  : last
    // Anything else (page nav, home/end) is rare for a 3-row list and not
    // tracked here; the worst case is the same as the previous clamp bug.
    let cursor = 0;
    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (!key || !key.name) return;
      if (key.meta && key.name !== 'escape') return;
      const last = AGENT_IDS.length - 1;
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
    };
    process.stdin.on('keypress', onKeypress);
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
      process.stdin.off('keypress', onKeypress);
    }
    let picked = (response.agents ?? []) as AgentId[];
    // If the user hit Enter without toggling anything, treat the highlighted
    // row as their pick. Saves a Space keystroke for the common single-agent case.
    if (picked.length === 0 && cursor >= 0 && cursor < AGENT_IDS.length) {
      picked = [AGENT_IDS[cursor]];
    }
    if (picked.length > 0) {
      process.stderr.write(`  Selected: ${picked.map((id) => AGENTS[id].displayName).join(', ')}\n`);
      return picked;
    }
    // Re-prompt with a visible inline warning (should not be reachable now).
    process.stderr.write('Select at least one agent.\n');
  }
}

async function promptSkills(): Promise<SkillName[]> {
  while (true) {
    let cursor = 0;
    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (!key || !key.name) return;
      if (key.meta && key.name !== 'escape') return;
      const last = SKILL_CATALOG.length - 1;
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
    };
    process.stdin.on('keypress', onKeypress);
    let response;
    try {
      response = await prompts(
        {
          type: 'multiselect',
          name: 'skills',
          message: 'Which Limrun skills do you want to install?',
          instructions: false,
          choices: SKILL_CATALOG.map((skill) => ({
            title: `${skill.name} (${skill.description})`,
            value: skill.name,
            selected: skill.defaultSelected,
          })),
          hint: 'Space to toggle, Enter to confirm (Enter alone picks the highlighted skill)',
        },
        {
          onCancel: () => {
            throw new PromptCancelled();
          },
        },
      );
    } finally {
      process.stdin.off('keypress', onKeypress);
    }
    let picked = uniqueSkillNames((response.skills ?? []) as string[]);
    if (picked.length === 0 && cursor >= 0 && cursor < SKILL_CATALOG.length) {
      picked = [SKILL_CATALOG[cursor].name];
    }
    if (picked.length > 0) {
      process.stderr.write(`  Selected skills: ${picked.join(', ')}\n`);
      return picked;
    }
    process.stderr.write('Select at least one skill.\n');
  }
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
    'Copy bundled Limrun skills into the native skills directory for each selected agent (Claude Code, Cursor, Codex). Pre-checks detected agents and lets you pick project or global scope.';
  static examples = [
    '<%= config.bin %> skills install',
    '<%= config.bin %> skills install --agents claude --agents cursor --scope project',
    '<%= config.bin %> skills install --agents cursor --scope project --skills limrun-ios --skills limrun-detox',
    '<%= config.bin %> skills install --agents codex --scope global --force',
  ];
  static flags = {
    agents: Flags.string({
      description: 'Target agent. Repeat to pick multiple.',
      multiple: true,
      options: ['claude', 'cursor', 'codex'],
    }),
    skills: Flags.string({
      description: 'Limrun skill to install. Repeat to pick multiple. Defaults to limrun-ios.',
      multiple: true,
      options: [...SKILL_NAMES],
    }),
    scope: Flags.string({
      description: 'Install scope.',
      options: ['project', 'global'],
    }),
    force: Flags.boolean({
      description: 'Overwrite existing skill files without confirmation.',
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
    let skills: SkillName[];
    let scope: Scope;

    if (flags.agents && flags.agents.length > 0) {
      agents = Array.from(new Set(flags.agents)) as AgentId[];
    } else if (interactive) {
      // Pre-check based on project-local presence only. Global installs of
      // agents (e.g. ~/.claude on a dev machine) are too weak a signal to
      // auto-select them for this specific project's install.
      agents = await promptAgents(detectAgentsForScope('project'));
    } else {
      this.error('--agents requires at least one of: claude, cursor, codex.', { exit: 2 });
    }

    if (flags.skills && flags.skills.length > 0) {
      skills = uniqueSkillNames(flags.skills);
    } else if (interactive) {
      skills = await promptSkills();
    } else {
      skills = [...DEFAULT_SKILL_NAMES];
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
      const source = sourceSkillMd(this.config, skill);
      if (!fs.existsSync(source)) {
        this.error(`Bundled skill source missing at ${source}.`, { exit: 1 });
      }
      sources.set(skill, source);
    }

    // Phase 1: Plan.
    const planned: PlannedTarget[] = [];
    for (const skill of skills) {
      const source = sources.get(skill)!;
      for (const id of agents) {
        const agent = AGENTS[id];
        const target = targetSkillMd(agent, scope, skill);
        const { kind } = planSkillFileCopy(source, target);
        planned.push({ skill, agent, scope, source, target, kind });
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
          'Existing skill files would be overwritten. Re-run with --force, or run interactively to confirm per target.\n',
        );
      }
      this.emitOutput(results, flags, skills);
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
        applySkillFileCopy(decision.target.source, decision.target.target);
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

    this.emitOutput(results, flags, skills);
  }

  private emitOutput(
    results: ResultRow[],
    flags: { json: boolean; quiet: boolean },
    skills: SkillName[],
  ): void {
    if (flags.json) {
      this.log(
        JSON.stringify(
          {
            ...(skills.length === 1 ? { skill: skills[0] } : {}),
            skills,
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
