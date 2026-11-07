import { ANDROID_PUBLISHER_SCOPE, PLAY_CONSOLE_SCOPE, PLAY_DEVELOPER_APP_SCOPE } from './google';
import { openGoogleCallback } from './internal/google-callback';
import { runtimeCrypto } from './internal/runtime';

export interface GoogleDesktopClient {
  clientId: string;
  clientSecret?: string;
}

export interface GoogleOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/** Reads the downloaded Google Cloud client configuration without accessing the filesystem. */
export function parseGoogleDesktopClient(config: unknown): GoogleDesktopClient {
  const client = (config as { installed?: { client_id?: unknown; client_secret?: unknown } })?.installed;
  if (
    typeof client?.client_id !== 'string' ||
    !client.client_id.endsWith('.apps.googleusercontent.com') ||
    (client.client_secret !== undefined && typeof client.client_secret !== 'string')
  ) {
    throw new Error('Expected a Google OAuth client JSON file for application type Desktop app.');
  }
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

async function requestToken(
  parameters: URLSearchParams,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<GoogleOAuthTokens> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 30_000);
  try {
    const response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: parameters,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    if (!response.ok) {
      // Provider bodies may echo credentials. Return only the status to the caller.
      throw new Error(`Google token request failed (HTTP ${response.status}). Sign in to Google again.`);
    }
    const token = (await response.json().catch(() => {
      throw new Error('Google returned an invalid token response.');
    })) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (
      typeof token.access_token !== 'string' ||
      !token.access_token ||
      typeof token.token_type !== 'string' ||
      token.token_type.toLowerCase() !== 'bearer' ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in! <= 0 ||
      (token.scope !== undefined &&
        (typeof token.scope !== 'string' || !token.scope.split(' ').includes(ANDROID_PUBLISHER_SCOPE)))
    ) {
      throw new Error('Google did not grant a Google Play publishing token. Sign in to Google again.');
    }
    return {
      accessToken: token.access_token,
      ...(typeof token.refresh_token === 'string' && token.refresh_token ?
        { refreshToken: token.refresh_token }
      : {}),
      expiresAt: Date.now() + token.expires_in! * 1000,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export interface AuthenticateGoogleDesktopInput extends GoogleDesktopClient {
  /** Open the system browser. An embedded webview cannot perform Google OAuth. */
  openBrowser: (url: string) => Promise<unknown> | unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Additional Console scope approved by Google for this OAuth client. */
  consoleScope?: typeof PLAY_CONSOLE_SCOPE | typeof PLAY_DEVELOPER_APP_SCOPE;
  fetch?: typeof fetch;
}

/** Performs Desktop OAuth with PKCE. The caller owns persistence of the returned refresh token. */
export async function authenticateGoogleDesktop(
  input: AuthenticateGoogleDesktopInput,
): Promise<GoogleOAuthTokens & { refreshToken: string }> {
  if (input.consoleScope && ![PLAY_CONSOLE_SCOPE, PLAY_DEVELOPER_APP_SCOPE].includes(input.consoleScope)) {
    throw new Error('Unsupported Play Console OAuth scope.');
  }
  const crypto = await runtimeCrypto();
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const callback = await openGoogleCallback(state, input.timeoutMs, input.signal);
  try {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: callback.redirectUri,
      response_type: 'code',
      scope: [ANDROID_PUBLISHER_SCOPE, input.consoleScope].filter(Boolean).join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    // Cancellation and the callback deadline also apply while a browser opener is pending.
    const code = await Promise.race([
      Promise.resolve()
        .then(() => input.openBrowser(url.toString()))
        .then(() => callback.code),
      callback.code,
    ]);
    input.signal?.throwIfAborted();
    const token = await requestToken(
      new URLSearchParams({
        client_id: input.clientId,
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: callback.redirectUri,
      }),
      input.fetch ?? fetch,
      input.signal,
    );
    input.signal?.throwIfAborted();
    if (!token.refreshToken) {
      throw new Error('Google returned no refresh token. Revoke the existing grant and sign in again.');
    }
    return { ...token, refreshToken: token.refreshToken };
  } finally {
    callback.close();
  }
}

export interface RefreshGoogleAccessTokenInput extends GoogleDesktopClient {
  refreshToken: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** Refreshes a publishing token; preserve the previous refresh token unless Google returns a replacement. */
export async function refreshGoogleAccessToken(
  input: RefreshGoogleAccessTokenInput,
): Promise<GoogleOAuthTokens> {
  return requestToken(
    new URLSearchParams({
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }),
    input.fetch ?? fetch,
    input.signal,
  );
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
