import { spawnSync } from 'child_process';
import { Flags } from '@oclif/core';
import prompts from 'prompts';
import { BaseCommand } from '../base-command';
import { readConfig } from '../lib/config';
import {
  beginLogin,
  collectLogin,
  login,
  pendingLoginInfo,
  readPendingLogin,
  type PendingLoginInfo,
} from '../lib/auth';
import { identity } from '../lib/backend';
import {
  LIMRUN_MCP_URL,
  MCP_AGENT_IDS,
  addLimrunMcp,
  detectMcpAgents,
  onPath,
  type McpAgentId,
  type McpResult,
} from '../lib/agent-mcp';

const VERSION = require('../../package.json').version;
const SKILLS_SOURCE = 'limrun-inc/skills';
// Pinned, because npx runs the package with this process's environment, API keys included.
const SKILLS_PACKAGE = 'skills@1.7.4';
/** Long enough for a cold npx download and a clone, short enough to finish before an agent shell gives up. */
const SKILLS_TIMEOUT_MS = 90_000;
/** Agent names in the `npx skills` CLI. */
const SKILLS_AGENT_NAMES: Record<McpAgentId, string> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini-cli',
};

type AuthResult =
  | { status: 'signed-in'; organizationId?: string; organizationName?: string }
  | ({ status: 'pending'; next: string } & PendingLoginInfo);

type SkillsResult =
  | { status: 'done'; agents: McpAgentId[]; results: SkillsAddResult[] }
  | { status: 'failed'; agents: McpAgentId[]; error: string }
  | { status: 'skipped'; reason: string };

/** One row of `npx skills add --json`. */
interface SkillsAddResult {
  name?: string;
  status: string;
  path?: string;
  error?: string;
}

export default class Setup extends BaseCommand {
  static summary = 'Set up Limrun for your coding agents in one step';
  static description = `Log in if needed, install the Limrun skills with \`npx skills add limrun-inc/skills\` (Node.js 22.20 or newer; update them later with \`npx skills update\`), and add the Limrun MCP server (${LIMRUN_MCP_URL}) to each coding agent found on this machine. Without a terminal, the login does not wait: the summary shows the URL and phrase to approve on any device; then run \`lim login\`, which continues the same login, or run setup again. Existing agent configs are merged, never replaced. Ends with a summary of what was done and what is blocked.`;
  static examples = [
    '<%= config.bin %> setup --yes',
    '<%= config.bin %> setup --yes --json',
    '<%= config.bin %> setup --yes --agents claude --agents codex',
  ];
  static flags = {
    ...BaseCommand.readOnlyFlags,
    yes: Flags.boolean({
      description: 'Do not ask for confirmation. Required without a terminal.',
      default: false,
    }),
    agents: Flags.string({
      description: 'Agent to set up. Repeat to pick multiple. Defaults to the agents found on this machine.',
      multiple: true,
      options: MCP_AGENT_IDS,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Setup);
    this.setParsedFlags(flags);
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !this.isJsonEnabled();
    const agents = flags.agents?.length ? [...new Set(flags.agents as McpAgentId[])] : detectMcpAgents();

    if (!flags.yes) {
      if (!interactive) {
        this.error('Pass --yes to run setup without a terminal.');
      }
      const { ok } = await prompts({
        type: 'confirm',
        name: 'ok',
        initial: true,
        message: `Log in to Limrun, install skills and add the MCP server for: ${
          agents.join(', ') || 'no agents found'
        }?`,
      });
      if (!ok) return;
    }

    const auth = await this.ensureLogin(interactive);
    const skills = this.installSkills(agents);
    // codex mcp add opens an OAuth page; before the Limrun login is approved it would be a second login.
    const mcp = agents.map(
      (agent): McpResult =>
        agent === 'codex' && auth.status === 'pending' ?
          {
            agent,
            status: 'blocked',
            via: 'codex mcp add',
            reason: 'Waits for the Limrun login. Run `lim setup --yes` again after approval.',
          }
        : addLimrunMcp(agent),
    );

    const blocked: string[] = [];
    if (auth.status === 'pending') {
      blocked.push(
        `Login: open ${auth.verificationUrl} on any device, confirm "${auth.phrase}", then run \`${auth.next}\`.`,
      );
    }
    if (agents.length === 0) {
      blocked.push('No coding agent found. Pass --agents to pick one.');
    }
    if (skills.status === 'failed') blocked.push(`Skills: ${skills.error}`);
    for (const result of mcp) {
      if (result.status === 'blocked') blocked.push(`MCP for ${result.agent}: ${result.reason}`);
    }

    const summary = { ok: blocked.length === 0, auth, skills, mcp, blocked };
    this.outputResult(summary, this.humanSummary(summary));
  }

  private async ensureLogin(interactive: boolean): Promise<AuthResult> {
    const config = readConfig();
    if (this.parsedFlags?.['api-key'] || config.apiKey) {
      const signedIn = await this.signedIn();
      if (signedIn) return signedIn;
      // An explicit key (--api-key, LIM_API_KEY) stays in use after a login, so a login cannot fix its rejection.
      if (this.parsedFlags?.['api-key']) {
        this.error('The API key was rejected; it may be revoked or expired.');
      }
    }

    if (interactive) {
      await login(config.apiEndpoint, config.consoleEndpoint, VERSION, {
        log: (message) => this.info(message),
      });
      return this.signedInAfterLogin();
    }

    // Without a terminal, start the login (or continue the one a previous run started) and do not wait.
    const options = {
      apiEndpoint: config.apiEndpoint,
      consoleEndpoint: config.consoleEndpoint,
      version: VERSION,
    };
    let begun = await beginLogin(options);
    if (begun.resumed) {
      let approved = false;
      try {
        approved = Boolean(await collectLogin(begun.pending, { once: true }));
      } catch {
        // A network error keeps the session; expiry or rejection removes it.
      }
      if (approved) return this.signedInAfterLogin();
      if (!readPendingLogin()) begun = await beginLogin(options);
    }
    return {
      status: 'pending',
      ...pendingLoginInfo(begun.pending),
      next: this.isJsonEnabled() ? 'lim login --json' : 'lim login',
    };
  }

  private async signedIn(): Promise<AuthResult | null> {
    this.resetClient();
    const who = await identity(this.client);
    return who ?
        {
          status: 'signed-in',
          ...(who.organizationId ? { organizationId: who.organizationId } : {}),
          ...(who.organizationName ? { organizationName: who.organizationName } : {}),
        }
      : null;
  }

  private async signedInAfterLogin(): Promise<AuthResult> {
    const signedIn = await this.signedIn();
    if (!signedIn) {
      this.error('Limrun rejected the API key from this login. Run `lim login` again.');
    }
    return signedIn;
  }

  /**
   * Installs the skills with `npx skills add`, which tracks them in
   * skills-lock.json so `npx skills update` and its security audit cover them.
   */
  private installSkills(agents: McpAgentId[]): SkillsResult {
    if (agents.length === 0) {
      return { status: 'skipped', reason: 'No agent selected.' };
    }
    // The engine `npx skills` declares; older Node fails inside the package with an unclear error.
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 20)) {
      return {
        status: 'failed',
        agents,
        error: `\`npx skills\` needs Node.js 22.20 or newer; this is ${process.versions.node}. Update Node.js, or run \`lim skills install\` instead.`,
      };
    }
    if (!onPath('npx')) {
      return { status: 'failed', agents, error: '`npx` is not on PATH. Install Node.js with npm.' };
    }
    this.info('Installing Limrun skills...');
    const child = spawnSync(
      'npx',
      [
        '-y',
        SKILLS_PACKAGE,
        'add',
        SKILLS_SOURCE,
        '--yes',
        '--json',
        ...agents.flatMap((agent) => ['-a', SKILLS_AGENT_NAMES[agent]]),
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        timeout: SKILLS_TIMEOUT_MS,
      },
    );
    let results: SkillsAddResult[] | undefined;
    try {
      results = JSON.parse(child.stdout) as SkillsAddResult[];
    } catch {
      // Not JSON: report stderr below.
    }
    const failed = results?.find((result) => result.status === 'failed');
    if (child.status !== 0 || !results || failed) {
      return {
        status: 'failed',
        agents,
        error:
          failed?.error ??
          (child.stderr?.trim().split('\n').pop() || String(child.error ?? 'npx skills failed')),
      };
    }
    return {
      status: 'done',
      agents,
      results: results.map(({ name, status, path }) => ({
        status,
        ...(name ? { name } : {}),
        ...(path ? { path } : {}),
      })),
    };
  }

  private humanSummary(summary: {
    auth: AuthResult;
    skills: SkillsResult;
    mcp: McpResult[];
    blocked: string[];
  }): string {
    const lines = [''];
    lines.push(
      summary.auth.status === 'signed-in' ?
        `  Login:  signed in${summary.auth.organizationName ? ` to ${summary.auth.organizationName}` : ''}`
      : '  Login:  waiting for approval',
    );
    lines.push(
      summary.skills.status === 'done' ?
        `  Skills: installed for ${summary.skills.agents.join(', ')}`
      : `  Skills: ${summary.skills.status}`,
    );
    for (const result of summary.mcp) {
      lines.push(`  MCP:    ${result.agent} ${result.status} (${result.via})`);
    }
    if (summary.blocked.length > 0) {
      lines.push('', '  To finish:', ...summary.blocked.map((item) => `    - ${item}`));
    }
    lines.push('');
    return lines.join('\n');
  }
}
