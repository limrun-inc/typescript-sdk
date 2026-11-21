import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const LIMRUN_MCP_NAME = 'limrun';
export const LIMRUN_MCP_URL = 'https://mcp.limrun.com/mcp';

export type McpAgentId = 'claude' | 'codex' | 'cursor' | 'gemini';
export const MCP_AGENT_IDS: McpAgentId[] = ['claude', 'codex', 'cursor', 'gemini'];

export interface McpResult {
  agent: McpAgentId;
  status: 'added' | 'unchanged' | 'blocked';
  /** The command run or the file written. */
  via: string;
  reason?: string;
}

/** `codex mcp add` starts the server's OAuth flow and waits for the browser; stop waiting after this. */
const CODEX_ADD_TIMEOUT_MS = 45_000;

export function onPath(command: string): boolean {
  const names = process.platform === 'win32' ? ['.cmd', '.exe'].map((ext) => command + ext) : [command];
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && names.some((name) => fs.existsSync(path.join(dir, name))));
}

/** JSON-config agents: where their user-level MCP servers live and how they spell an HTTP server. */
const JSON_AGENTS = {
  cursor: { dir: '.cursor', file: 'mcp.json', entry: { url: LIMRUN_MCP_URL } },
  gemini: { dir: '.gemini', file: 'settings.json', entry: { httpUrl: LIMRUN_MCP_URL } },
} as const;

/** Agents installed on this machine: a CLI on PATH, or a config directory in the home folder. */
export function detectMcpAgents(): McpAgentId[] {
  return MCP_AGENT_IDS.filter(
    (id) =>
      onPath(id) ||
      ((id === 'cursor' || id === 'gemini') && fs.existsSync(path.join(os.homedir(), JSON_AGENTS[id].dir))),
  );
}

/**
 * Adds `name` to the `mcpServers` object of a JSON config, keeping every
 * other key and server. An existing entry under `name` is kept as the user
 * wrote it. Throws on content that is not a JSON object, so a file we cannot
 * read is never overwritten.
 */
export function mergeMcpServerJson(
  text: string | undefined,
  name: string,
  entry: Record<string, unknown>,
): { text: string; changed: boolean } {
  const config: unknown = text?.trim() ? JSON.parse(text) : {};
  if (!isObject(config)) {
    throw new Error('the file is not a JSON object');
  }
  const servers = config['mcpServers'] ?? {};
  if (!isObject(servers)) {
    throw new Error('"mcpServers" is not a JSON object');
  }
  if (name in servers) {
    return { text: text!, changed: false };
  }
  config['mcpServers'] = { ...servers, [name]: entry };
  return { text: JSON.stringify(config, null, 2) + '\n', changed: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function addLimrunMcp(agent: McpAgentId): McpResult {
  if (agent === 'cursor' || agent === 'gemini') {
    const { dir, file, entry } = JSON_AGENTS[agent];
    const configPath = path.join(os.homedir(), dir, file);
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined;
    let merged: { text: string; changed: boolean };
    try {
      merged = mergeMcpServerJson(existing, LIMRUN_MCP_NAME, entry);
    } catch (err) {
      return {
        agent,
        status: 'blocked',
        via: configPath,
        reason: `Cannot read ${configPath}: ${
          err instanceof Error ? err.message : String(err)
        }. Fix it or add the server by hand.`,
      };
    }
    if (merged.changed) {
      // Write a sibling file and rename it over the config, so a stopped process never leaves it cut short.
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const temporaryPath = `${configPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, merged.text, {
        ...(existing !== undefined ? { mode: fs.statSync(configPath).mode & 0o777 } : {}),
      });
      fs.renameSync(temporaryPath, configPath);
    }
    return { agent, status: merged.changed ? 'added' : 'unchanged', via: configPath };
  }

  const addArgs =
    agent === 'claude' ?
      ['mcp', 'add', '--transport', 'http', '--scope', 'user', LIMRUN_MCP_NAME, LIMRUN_MCP_URL]
    : ['mcp', 'add', LIMRUN_MCP_NAME, '--url', LIMRUN_MCP_URL];
  const via = `${agent} ${addArgs.join(' ')}`;
  if (!onPath(agent)) {
    return { agent, status: 'blocked', via, reason: `The ${agent} CLI is not on PATH.` };
  }
  // `claude mcp get` also matches project and local entries, so Claude's own add reports a user-scope duplicate.
  if (agent === 'codex' && run(agent, ['mcp', 'get', LIMRUN_MCP_NAME]).status === 0) {
    return { agent, status: 'unchanged', via };
  }
  const added = run(agent, addArgs, agent === 'codex' ? CODEX_ADD_TIMEOUT_MS : undefined);
  if (added.status === 0) {
    return { agent, status: 'added', via };
  }
  const output = `${added.stderr ?? ''}\n${added.stdout ?? ''}`.trim();
  if (agent === 'claude' && output.includes('already exists in user config')) {
    return { agent, status: 'unchanged', via };
  }
  // Codex writes the server before its OAuth step, so a failed or timed-out OAuth still leaves it added.
  if (agent === 'codex' && run(agent, ['mcp', 'get', LIMRUN_MCP_NAME]).status === 0) {
    return {
      agent,
      status: 'added',
      via,
      reason: 'Added, but OAuth did not finish. Run `codex mcp login limrun`.',
    };
  }
  return { agent, status: 'blocked', via, reason: output || String(added.error) };
}

function run(command: string, args: string[], timeout?: number) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...(timeout ? { timeout } : {}),
  });
}
