import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import { AuthenticationError, PermissionDeniedError } from '@limrun/api';
import { writeConfig, CONFIG_KEYS, PENDING_LOGIN_FILE } from './config';
import {
  captureTelemetry,
  getTelemetryInstallationId,
  telemetryErrorCategory,
  type TelemetryCapture,
} from './telemetry';

const LOGIN_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface LoginOptions {
  apiEndpoint: string;
  consoleEndpoint: string;
  version: string;
  log?: (message: string) => void;
  configWriter?: typeof writeConfig;
  opener?: (url: string) => Promise<unknown> | unknown;
  fetcher?: typeof fetch;
  hostname?: string;
  anonymousId?: string;
  telemetry?: TelemetryCapture;
  pendingLoginFile?: string;
  /** Called once the URL and phrase are known, before waiting; `--json` prints them here. */
  onPending?: (info: PendingLoginInfo) => void;
}

interface CreateSessionResponse {
  sessionId: string;
  secret: string;
  phrase: string;
  verificationUrl: string;
  expiresAt: string;
  pollIntervalSeconds?: number;
}

interface CollectTokenResponse {
  apiKey?: string;
  organizationId?: string;
  message?: string;
}

interface CollectedToken {
  apiKey: string;
  organizationId?: string;
}

/** A started login, stored so that running `lim login` again continues it with the same phrase. */
interface PendingLogin extends CreateSessionResponse {
  apiEndpoint: string;
}

/** The pending session without its secret, safe to print. */
export interface PendingLoginInfo {
  verificationUrl: string;
  phrase: string;
  expiresAt: string;
}

type LoginRuntimeOptions = Omit<LoginOptions, 'apiEndpoint' | 'consoleEndpoint' | 'version'>;

class RetryableLoginError extends Error {}
class LoginTimeoutError extends Error {}

export function isLoginRequiredError(err: unknown): boolean {
  if (err instanceof AuthenticationError) {
    return true;
  }
  if (!(err instanceof PermissionDeniedError)) {
    return false;
  }
  const error = err.error as { message?: unknown };
  return typeof error.message === 'string' && error.message.startsWith('unauthenticated:');
}

async function openLoginUrl(url: string): Promise<void> {
  const importEsm = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<typeof import('open')>;
  const { default: open } = await importEsm('open');
  await open(url);
}

export async function login(
  apiEndpoint: string,
  consoleEndpoint: string,
  version: string,
  options: LoginRuntimeOptions = {},
): Promise<void> {
  return loginWithOptions({ ...options, apiEndpoint, consoleEndpoint, version });
}

export async function loginWithOptions(options: LoginOptions): Promise<void> {
  const { log = console.log } = options;
  const telemetry = options.telemetry ?? captureTelemetry;

  try {
    const { pending, resumed } = await beginLogin(options);
    if (resumed) {
      log('\nContinuing the login started earlier.');
    }
    log(`\nConfirm this phrase in your browser: ${pending.phrase}`);
    log(`${resumed ? 'Open' : 'Opening'} this URL to log in: ${pending.verificationUrl}\n\n`);
    options.onPending?.(pendingLoginInfo(pending));

    if (!resumed) {
      try {
        await (options.opener ?? openLoginUrl)(pending.verificationUrl);
      } catch {
        // The URL is already printed above, so a failed opener does not block login.
      }
    }
    log('Waiting for you to confirm in browser...');
    await collectLogin(pending, options);
  } catch (err) {
    await emitTelemetry(telemetry, 'cli_auth_failed', {
      auth_method: 'browser',
      error_category: telemetryErrorCategory(err),
    });
    throw err;
  }
}

/**
 * Continues the stored login when it is still pending, so a rerun after the
 * command was stopped (Ctrl-C, or an agent shell's time limit) keeps the URL
 * and phrase the user already has. Otherwise starts a new one and stores it.
 */
async function beginLogin(options: LoginOptions): Promise<{ pending: PendingLogin; resumed: boolean }> {
  const { apiEndpoint, pendingLoginFile = PENDING_LOGIN_FILE } = options;
  const stored = readPendingLogin(pendingLoginFile);
  if (stored && stored.apiEndpoint === apiEndpoint && !isPendingLoginExpired(stored)) {
    return { pending: stored, resumed: true };
  }

  await emitTelemetry(options.telemetry ?? captureTelemetry, 'cli_auth_started', { auth_method: 'browser' });
  const session = await createSession(
    options.fetcher ?? fetch,
    apiEndpoint,
    options.consoleEndpoint,
    options.hostname ?? computerName(),
    options.version,
    Date.now() + LOGIN_CALLBACK_TIMEOUT_MS,
    options.anonymousId ?? getTelemetryInstallationId(),
  );
  const pending: PendingLogin = { ...session, apiEndpoint };
  fs.mkdirSync(path.dirname(pendingLoginFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingLoginFile, JSON.stringify(pending), { mode: 0o600 });
  return { pending, resumed: false };
}

/** Waits until the user approves or the session expires. Either outcome consumes the stored session. */
async function collectLogin(pending: PendingLogin, options: LoginOptions): Promise<CollectedToken> {
  const { configWriter = writeConfig, fetcher = fetch, pendingLoginFile = PENDING_LOGIN_FILE } = options;
  let token: CollectedToken;
  try {
    token = await pollUntilApproved(fetcher, pending.apiEndpoint, pending, Date.parse(pending.expiresAt));
  } catch (err) {
    fs.rmSync(pendingLoginFile, { force: true });
    throw err;
  }
  configWriter({ [CONFIG_KEYS.apiKey]: token.apiKey });
  fs.rmSync(pendingLoginFile, { force: true });
  return token;
}

export function readPendingLogin(pendingLoginFile = PENDING_LOGIN_FILE): PendingLogin | null {
  try {
    return JSON.parse(fs.readFileSync(pendingLoginFile, 'utf8')) as PendingLogin;
  } catch {
    return null;
  }
}

export function pendingLoginInfo(pending: PendingLogin): PendingLoginInfo {
  const { verificationUrl, phrase, expiresAt } = pending;
  return { verificationUrl, phrase, expiresAt };
}

export function isPendingLoginExpired(pending: PendingLogin): boolean {
  return !(Date.parse(pending.expiresAt) > Date.now());
}

async function pollUntilApproved(
  fetcher: typeof fetch,
  apiEndpoint: string,
  session: CreateSessionResponse,
  deadline: number,
): Promise<CollectedToken> {
  const pollIntervalMs = Math.max(1, session.pollIntervalSeconds ?? 2) * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      throw loginTimeoutError();
    }

    let token: CollectedToken | null;
    try {
      token = await pollForToken(fetcher, apiEndpoint, session, deadline);
    } catch (err) {
      if (!(err instanceof RetryableLoginError) || Date.now() >= deadline) {
        throw err;
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      continue;
    }
    if (token) {
      return token;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

function computerName(): string {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (name) {
        return name;
      }
    } catch {
      // Fall through to generic OS names.
    }
  }
  if (process.platform === 'win32' && process.env['COMPUTERNAME']) {
    return process.env['COMPUTERNAME'];
  }
  return os.hostname();
}

async function createSession(
  fetcher: typeof fetch,
  apiEndpoint: string,
  consoleEndpoint: string,
  hostname: string,
  version: string,
  deadline: number,
  anonymousId?: string,
): Promise<CreateSessionResponse> {
  const response = await fetchWithDeadline(fetcher, new URL('/authn/cli/sessions', apiEndpoint), deadline, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ hostname, cliVersion: version, ...(anonymousId ? { anonymousId } : {}) }),
  });
  if (!response.ok) {
    throw new Error(`Failed to start CLI login session: ${await responseMessage(response)}`);
  }
  const session = (await response.json()) as CreateSessionResponse;
  if (!session.sessionId || !session.secret || !session.phrase) {
    throw new Error('Backend returned an invalid CLI login session.');
  }
  if (!(Date.parse(session.expiresAt) > Date.now())) {
    session.expiresAt = new Date(Date.now() + LOGIN_CALLBACK_TIMEOUT_MS).toISOString();
  }
  if (!session.verificationUrl) {
    const verificationUrl = new URL('/authn/cli', consoleEndpoint);
    verificationUrl.searchParams.set('session', session.sessionId);
    session.verificationUrl = verificationUrl.toString();
  }
  return session;
}

async function pollForToken(
  fetcher: typeof fetch,
  apiEndpoint: string,
  session: CreateSessionResponse,
  deadline: number,
): Promise<CollectedToken | null> {
  const url = new URL(`/authn/cli/sessions/${encodeURIComponent(session.sessionId)}/token`, apiEndpoint);
  url.searchParams.set('secret', session.secret);
  let response: Response;
  try {
    response = await fetchWithDeadline(fetcher, url, deadline);
  } catch (err) {
    if (err instanceof LoginTimeoutError) {
      throw err;
    }
    throw new RetryableLoginError(
      `Failed while waiting for CLI login approval: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (response.status === 202) {
    return null;
  }
  if (response.status === 410) {
    throw new Error('CLI login session expired. Run `lim login` again to retry.');
  }
  if (!response.ok) {
    const message = `Failed while waiting for CLI login approval: ${await responseMessage(response)}`;
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new RetryableLoginError(message);
    }
    throw new Error(message);
  }
  const body = (await response.json()) as CollectTokenResponse;
  if (!body.apiKey) {
    throw new Error('Backend approved the CLI login session without returning an API key.');
  }
  return {
    apiKey: body.apiKey,
    ...(body.organizationId ? { organizationId: body.organizationId } : {}),
  };
}

async function fetchWithDeadline(
  fetcher: typeof fetch,
  input: URL,
  deadline: number,
  init: RequestInit = {},
): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw loginTimeoutError();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw loginTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function loginTimeoutError(): LoginTimeoutError {
  return new LoginTimeoutError(
    'Login timed out waiting for browser authorization. Run `lim login` again to retry.',
  );
}

export async function responseMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitTelemetry(
  telemetry: TelemetryCapture,
  event: Parameters<TelemetryCapture>[0],
  properties: Parameters<TelemetryCapture>[1],
): Promise<void> {
  try {
    await telemetry(event, properties);
  } catch {
    // Analytics must never change authentication behavior.
  }
}
