import fs from 'fs';
import path from 'path';
import os from 'os';
import { getScopeKey, isGlobalScopeKey, setScopeOverride } from './scope';
import { assignWorkspaceDir, normalizeDir } from './workspace';
import { clearWorkspaceInstances } from './config';
import {
  loadMCPConnection,
  pairingDirectory,
  saveMCPConnection,
  validEndpoint,
  writePrivateJSON,
} from './mcp-connection';

const SESSION_ID = /^mcpcli_[0-9a-z]{26}$/;
interface PendingPairing {
  sessionId: string;
  secret: string;
  scope: string;
  apiEndpoint: string;
  authEndpoint: string;
  consoleEndpoint: string;
  organizationId: string;
  expiresAt: string;
}

function pendingFile(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid MCP pairing session ID.');
  return path.join(pairingDirectory(), `${sessionId}.json`);
}

export async function beginMCPLogin(
  input: { apiEndpoint: string; authEndpoint: string; consoleEndpoint: string; organizationId: string },
  version: string,
  fetcher: typeof fetch = fetch,
) {
  const apiEndpoint = validEndpoint(input.apiEndpoint);
  const authEndpoint = validEndpoint(input.authEndpoint);
  const consoleEndpoint = validEndpoint(input.consoleEndpoint);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.organizationId))
    throw new Error('Invalid organization ID from MCP.');
  if (isGlobalScopeKey(getScopeKey())) {
    assignWorkspaceDir(process.cwd(), normalizeDir(process.cwd()));
    setScopeOverride(normalizeDir(process.cwd()));
  }
  const response = await fetcher(new URL('/authn/cli/sessions', authEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ hostname: os.hostname(), cliVersion: version, mcp: true }),
  });
  if (!response.ok) throw new Error(`Could not start MCP CLI pairing (${response.status}).`);
  const session = (await response.json()) as {
    sessionId: string;
    secret: string;
    phrase: string;
    expiresAt: string;
  };
  if (
    !SESSION_ID.test(session.sessionId) ||
    typeof session.secret !== 'string' ||
    !session.secret ||
    typeof session.phrase !== 'string' ||
    !session.phrase ||
    !Number.isFinite(Date.parse(session.expiresAt))
  ) {
    throw new Error('Invalid MCP pairing response.');
  }
  writePrivateJSON(pendingFile(session.sessionId), {
    sessionId: session.sessionId,
    secret: session.secret,
    scope: getScopeKey(),
    apiEndpoint,
    authEndpoint,
    consoleEndpoint,
    organizationId: input.organizationId,
    expiresAt: session.expiresAt,
  } satisfies PendingPairing);
  return { sessionId: session.sessionId, phrase: session.phrase, expiresAt: session.expiresAt };
}

export async function completeMCPLogin(sessionId: string, fetcher: typeof fetch = fetch) {
  const file = pendingFile(sessionId);
  const pending = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingPairing;
  if (pending.sessionId !== sessionId || pending.scope !== getScopeKey())
    throw new Error('Complete pairing from the same workspace that started it.');
  if (!Number.isFinite(Date.parse(pending.expiresAt)) || Date.parse(pending.expiresAt) <= Date.now())
    throw new Error('Pairing expired. Start a new MCP CLI pairing.');
  const endpoint = validEndpoint(pending.apiEndpoint);
  const authEndpoint = validEndpoint(pending.authEndpoint);
  validEndpoint(pending.consoleEndpoint);
  const url = new URL(`/authn/cli/sessions/${sessionId}/token`, authEndpoint);
  url.searchParams.set('secret', pending.secret);
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status === 202)
    throw new Error('Pairing is not approved yet. Call approve-cli-login, then complete it again.');
  if (!response.ok)
    throw new Error(
      `Could not complete MCP CLI pairing (${response.status}). Start a new pairing if it expired.`,
    );
  const result = (await response.json()) as { apiKey?: string; organizationId?: string; expiresAt?: string };
  if (
    result.organizationId !== pending.organizationId ||
    !result.apiKey ||
    !result.expiresAt ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    Date.parse(result.expiresAt) <= Date.now()
  ) {
    throw new Error(
      'MCP pairing returned a different account or invalid credential. No CLI connection was saved.',
    );
  }
  const previous = loadMCPConnection();
  if (!previous || previous.apiEndpoint !== endpoint || previous.organizationId !== pending.organizationId)
    clearWorkspaceInstances();
  saveMCPConnection({
    apiKey: result.apiKey,
    apiEndpoint: endpoint,
    consoleEndpoint: pending.consoleEndpoint,
    organizationId: result.organizationId,
    expiresAt: result.expiresAt,
  });
  fs.unlinkSync(file);
  return { organizationId: result.organizationId, apiEndpoint: endpoint, expiresAt: result.expiresAt };
}
