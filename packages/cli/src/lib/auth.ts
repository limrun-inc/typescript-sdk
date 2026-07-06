import os from 'os';
import { writeConfig, CONFIG_KEYS } from './config';

const LOGIN_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface LoginOptions {
  apiEndpoint: string;
  consoleEndpoint: string;
  version: string;
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

async function openLoginUrl(url: string): Promise<void> {
  const importEsm = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<typeof import('open')>;
  const { default: open } = await importEsm('open');
  await open(url);
}

export async function login(apiEndpoint: string, consoleEndpoint: string, version: string): Promise<void> {
  return loginWithOptions({ apiEndpoint, consoleEndpoint, version });
}

export async function loginWithOptions(options: LoginOptions): Promise<void> {
  const {
    apiEndpoint,
    consoleEndpoint,
    version,
    configWriter = writeConfig,
    fetcher = fetch,
    hostname = os.hostname(),
  } = options;

  const session = await createSession(fetcher, apiEndpoint, consoleEndpoint, hostname, version);
  console.log(`Confirm this phrase in your browser: ${session.phrase}`);
  console.log(`Open this URL to log in:\n${session.verificationUrl}`);

  Promise.resolve((options.opener ?? openLoginUrl)(session.verificationUrl)).catch(() => {
    // The URL is already printed above, so a failed opener does not block login.
  });

  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_CALLBACK_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, session.pollIntervalSeconds ?? 2) * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error('Login timed out waiting for browser authorization. Run `lim login` again to retry.');
    }

    const token = await pollForToken(fetcher, apiEndpoint, session);
    if (token) {
      configWriter({ [CONFIG_KEYS.apiKey]: token });
      return;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

async function createSession(
  fetcher: typeof fetch,
  apiEndpoint: string,
  consoleEndpoint: string,
  hostname: string,
  version: string,
): Promise<CreateSessionResponse> {
  const response = await fetcher(new URL('/authn/cli/sessions', apiEndpoint), {
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
): Promise<string | null> {
  const url = new URL(`/authn/cli/sessions/${encodeURIComponent(session.sessionId)}/token`, apiEndpoint);
  url.searchParams.set('secret', session.secret);
  const response = await fetcher(url);
  if (response.status === 202) {
    return null;
  }
  if (response.status === 410) {
    throw new Error('CLI login session expired. Run `lim login` again to retry.');
  }
  if (!response.ok) {
    throw new Error(`Failed while waiting for CLI login approval: ${await responseMessage(response)}`);
  }
  const body = (await response.json()) as CollectTokenResponse;
  if (!body.apiKey) {
    throw new Error('Backend approved the CLI login session without returning an API key.');
  }
  return body.apiKey;
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
