import { execFileSync } from 'child_process';
import os from 'os';
import process from 'process';
import { writeConfig, CONFIG_KEYS } from './config';

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
  timeoutMs?: number;
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
  message?: string;
}

type LoginRuntimeOptions = Omit<LoginOptions, 'apiEndpoint' | 'consoleEndpoint' | 'version'>;

class RetryableLoginError extends Error {}
class LoginTimeoutError extends Error {}

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
  const {
    apiEndpoint,
    consoleEndpoint,
    version,
    configWriter = writeConfig,
    fetcher = fetch,
    hostname = computerName(),
    log = console.log,
  } = options;

  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_CALLBACK_TIMEOUT_MS);
  const session = await createSession(fetcher, apiEndpoint, consoleEndpoint, hostname, version, deadline);
  log(`\nConfirm this phrase in your browser: ${session.phrase}`);
  log(`Opening this URL to log in: ${session.verificationUrl}\n\n`);

  try {
    await (options.opener ?? openLoginUrl)(session.verificationUrl);
  } catch {
    // The URL is already printed above, so a failed opener does not block login.
  }
  log('Waiting for you to confirm in browser...');

  const pollIntervalMs = Math.max(1, session.pollIntervalSeconds ?? 2) * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      throw loginTimeoutError();
    }

    let token: string | null;
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
      configWriter({ [CONFIG_KEYS.apiKey]: token });
      return;
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
): Promise<CreateSessionResponse> {
  const response = await fetchWithDeadline(fetcher, new URL('/authn/cli/sessions', apiEndpoint), deadline, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ hostname, cliVersion: version }),
  });
  if (!response.ok) {
    throw new Error(`Failed to start CLI login session: ${await responseMessage(response)}`);
  }
  const session = (await response.json()) as CreateSessionResponse;
  if (!session.sessionId || !session.secret || !session.phrase) {
    throw new Error('Backend returned an invalid CLI login session.');
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
): Promise<string | null> {
  const url = new URL(`/authn/cli/sessions/${encodeURIComponent(session.sessionId)}/token`, apiEndpoint);
  url.searchParams.set('secret', session.secret);
  let response: Response;
  try {
    response = await fetchWithDeadline(fetcher, url, deadline);
  } catch (err) {
    if (err instanceof LoginTimeoutError) {
      throw err;
    }
    throw new RetryableLoginError(`Failed while waiting for CLI login approval: ${err instanceof Error ? err.message : String(err)}`);
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
  return body.apiKey;
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
  return new LoginTimeoutError('Login timed out waiting for browser authorization. Run `lim login` again to retry.');
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as CollectTokenResponse;
    return body.message || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
