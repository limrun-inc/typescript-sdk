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

const SKILL_NAME = 'limrun-ios';
const SKIPPED_REASON_CONFLICT = 'existing content differs; re-run with --force to overwrite';
const SKIPPED_REASON_BLOCKED = 'blocked: another target requires --force to proceed';
const SKIPPED_REASON_DECLINED = 'user declined overwrite confirmation';

type Status = 'installed' | 'updated' | 'unchanged' | 'skipped';

interface PlannedTarget {
  agent: AgentSpec;
  scope: Scope;
  source: string;
  target: string;
  kind: 'install' | 'unchanged' | 'conflict';
}

interface ResultRow {
  agent: AgentId;
  scope: Scope;
  path: string;
  status: Status;
  reason?: string;
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

function detectAgentsAcrossScopes(): Set<AgentId> {
  const merged = new Set<AgentId>([...detectAgentsForScope('project'), ...detectAgentsForScope('global')]);
  return merged;
}

async function promptAgents(preselected: Set<AgentId>): Promise<AgentId[]> {
  // Loop to enforce "at least one agent" without crashing.
  while (true) {
    const response = await prompts(
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
        hint: 'Space to toggle, Enter to confirm',
      },
      {
        onCancel: () => {
          throw new PromptCancelled();
        },
      },
    );
    const picked = (response.agents ?? []) as AgentId[];
    if (picked.length > 0) {
      return picked;
    }
    // Re-prompt with a visible inline warning.
    process.stderr.write('Select at least one agent.\n');
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
    'Copy the bundled Limrun skill into the native skills directory for each selected agent (Claude Code, Cursor, Codex). Pre-checks detected agents and lets you pick project or global scope.';
  static examples = [
    '<%= config.bin %> skills install',
    '<%= config.bin %> skills install --agents claude --agents cursor --scope project',
    '<%= config.bin %> skills install --agents codex --scope global --force',
  ];
  static flags = {
    agents: Flags.string({
      description: 'Target agent. Repeat to pick multiple.',
      multiple: true,
      options: ['claude', 'cursor', 'codex'],
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
    let scope: Scope;

    if (flags.agents && flags.agents.length > 0) {
      agents = Array.from(new Set(flags.agents)) as AgentId[];
    } else if (interactive) {
      agents = await promptAgents(detectAgentsAcrossScopes());
    } else {
      this.error('--agents requires at least one of: claude, cursor, codex.', { exit: 2 });
    }

    if (flags.scope) {
      scope = flags.scope as Scope;
    } else if (interactive) {
      scope = await promptScope();
    } else {
      this.error('Specify --agents and --scope in non-interactive mode.', { exit: 2 });
    }

    const source = sourceSkillMd(this.config, SKILL_NAME);
    if (!fs.existsSync(source)) {
      this.error(`Bundled skill source missing at ${source}.`, { exit: 1 });
    }

    // Phase 1: Plan.
    const planned: PlannedTarget[] = agents.map((id) => {
      const agent = AGENTS[id];
      const target = targetSkillMd(agent, scope, SKILL_NAME);
      const { kind } = planSkillFileCopy(source, target);
      return { agent, scope, source, target, kind };
    });

    // Phase 2: Confirm.
    const results: ResultRow[] = [];
    const anyConflict = planned.some((t) => t.kind === 'conflict');

    if (anyConflict && !flags.force && !interactive) {
      // Non-interactive + conflict + no force: all-or-nothing. Skip all targets.
      for (const t of planned) {
        results.push({
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
      this.emitOutput(results, flags);
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
        agent: decision.target.agent.id,
        scope: decision.target.scope,
        path: decision.target.target,
        status: decision.status,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    }

    this.emitOutput(results, flags);
  }

  private emitOutput(results: ResultRow[], flags: { json: boolean; quiet: boolean }): void {
    if (flags.json) {
      this.log(
        JSON.stringify(
          {
            skill: SKILL_NAME,
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
    this.log(`  ${SKILL_NAME}`);
    const colWidth = Math.max(
      ...results.map((r) => AGENTS[r.agent].displayName.length),
      'Claude Code'.length,
    );
    for (const r of results) {
      const agentLabel = AGENTS[r.agent].displayName.padEnd(colWidth);
      const displayPath = humanPath(r.path, r.scope);
      const reason = r.reason ? `  (${r.reason})` : '';
      this.log(`    ${agentLabel}  ->  ${displayPath}    ${statusLabel(r.status)}${reason}`);
    }
    this.log('');
  }
}
