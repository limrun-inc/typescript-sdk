import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { getScopeKey } from './scope';

export interface MCPConnection {
  apiKey: string;
  apiEndpoint: string;
  consoleEndpoint: string;
  organizationId: string;
  expiresAt: string;
}

export function pairingDirectory(): string {
  const dir = path.join(os.homedir(), '.lim', 'mcp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writePrivateJSON(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

function connectionFile(): string {
  const scope = createHash('sha256').update(getScopeKey()).digest('hex');
  return path.join(pairingDirectory(), `workspace-${scope}.json`);
}

export function loadMCPConnection(): MCPConnection | null {
  const file = connectionFile();
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as MCPConnection;
  if (
    !value ||
    typeof value.apiKey !== 'string' ||
    typeof value.organizationId !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !value.apiEndpoint ||
    !value.consoleEndpoint
  ) {
    throw new Error('Invalid MCP workspace connection. Pair the CLI again.');
  }
  return value;
}

export function saveMCPConnection(connection: MCPConnection): void {
  writePrivateJSON(connectionFile(), connection);
}

export function validEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'The Limrun endpoint must be an HTTPS origin without credentials, a path, or query parameters.',
    );
  }
  return url.origin;
}

export function checkedMCPConnection(): MCPConnection | null {
  const connection = loadMCPConnection();
  if (!connection) return null;
  const endpoint = validEndpoint(connection.apiEndpoint);
  validEndpoint(connection.consoleEndpoint);
  if (
    (process.env['LIM_API_ENDPOINT'] && validEndpoint(process.env['LIM_API_ENDPOINT']) !== endpoint) ||
    (process.env['LIM_CONSOLE_ENDPOINT'] &&
      validEndpoint(process.env['LIM_CONSOLE_ENDPOINT']) !== connection.consoleEndpoint) ||
    (process.env['LIM_API_KEY'] && process.env['LIM_API_KEY'] !== connection.apiKey)
  ) {
    throw new Error(
      'Environment credentials or endpoints conflict with this workspace’s MCP connection. Unset the conflicting LIM_API_KEY/LIM_API_ENDPOINT/LIM_CONSOLE_ENDPOINT variables; no other account was used.',
    );
  }
  if (
    !connection.apiKey ||
    !Number.isFinite(Date.parse(connection.expiresAt)) ||
    Date.parse(connection.expiresAt) <= Date.now()
  ) {
    throw new Error(
      'MCP CLI access expired. Pair this workspace again through get-cli-auth-context and approve-cli-login.',
    );
  }
  return connection;
}
