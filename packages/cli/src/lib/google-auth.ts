import { readFile } from 'node:fs/promises';
import {
  authenticateGoogleDesktop,
  parseGoogleDesktopClient,
  refreshGoogleAccessToken,
  type GoogleDesktopClient,
  type AuthenticateGoogleDesktopInput,
} from '@limrun/play-auth';
import { LocalSecretStore } from './local-secret-store';

const SECRET_TYPE = 'googlePlayOAuth';
const SECRET_NAME = 'default';

export async function readGoogleDesktopClient(file: string): Promise<GoogleDesktopClient> {
  const content = await readFile(file, 'utf8');
  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch {
    throw new Error('The Google Desktop OAuth client file is not valid JSON. Download a new copy.');
  }
  return parseGoogleDesktopClient(config);
}

export async function authenticateGoogle(
  client: GoogleDesktopClient,
  openBrowser: (url: string) => Promise<unknown>,
  store = new LocalSecretStore(),
  fetcher: typeof fetch = fetch,
  consoleScope?: AuthenticateGoogleDesktopInput['consoleScope'],
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const token = await authenticateGoogleDesktop({
      ...client,
      consoleScope,
      openBrowser,
      signal: controller.signal,
      fetch: fetcher,
    });
    await store.put(SECRET_TYPE, SECRET_NAME, { ...client, refreshToken: token.refreshToken });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

export async function savedGoogleAccessToken(
  store = new LocalSecretStore(),
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const saved = await store.get(SECRET_TYPE, SECRET_NAME);
  if (!saved) return undefined;
  const { clientId, clientSecret, refreshToken } = saved.data;
  if (!clientId || !refreshToken)
    throw new Error('Saved Google credentials are incomplete. Run lim android play auth again.');
  let token;
  try {
    token = await refreshGoogleAccessToken({ clientId, clientSecret, refreshToken, fetch: fetcher });
  } catch (error) {
    throw new Error(
      `${
        error instanceof Error ? error.message : 'Google token refresh failed.'
      } Run lim android play auth again.`,
    );
  }
  if (token.refreshToken && token.refreshToken !== refreshToken) {
    await store.put(SECRET_TYPE, SECRET_NAME, { ...saved.data, refreshToken: token.refreshToken });
  }
  return token.accessToken;
}
