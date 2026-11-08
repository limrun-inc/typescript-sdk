import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ANDROID_PUBLISHER_SCOPE } from '@limrun/play-auth';
import { authenticateGoogle, readGoogleDesktopClient, savedGoogleAccessToken } from './google-auth';
import { LocalSecretStore } from './local-secret-store';

describe('Google Desktop OAuth', () => {
  let directory: string;
  let store: LocalSecretStore;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'lim-google-'));
    store = new LocalSecretStore(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts a downloaded desktop client and rejects a web client', async () => {
    const file = path.join(directory, 'client.json');
    const client = { client_id: '123.apps.googleusercontent.com', client_secret: 'secret' };
    await writeFile(file, JSON.stringify({ installed: client }));
    expect(await readGoogleDesktopClient(file)).toEqual({
      clientId: client.client_id,
      clientSecret: 'secret',
    });
    await writeFile(file, JSON.stringify({ web: client }));
    await expect(readGoogleDesktopClient(file)).rejects.toThrow('Desktop app');
    await writeFile(file, 'SENSITIVE_CLIENT_SECRET');
    await expect(readGoogleDesktopClient(file)).rejects.toThrow('not valid JSON');
    await expect(readGoogleDesktopClient(file)).rejects.not.toThrow('SENSITIVE_CLIENT_SECRET');
  });

  it.each([
    undefined,
    'https://www.googleapis.com/auth/play_console' as const,
    'https://www.googleapis.com/auth/playdeveloperapp' as const,
  ])('checks PKCE and saves reusable credentials with Console scope %s', async (consoleScope) => {
    let authorization: URL;
    const fetcher = jest.fn(async (input: unknown, init?: RequestInit) => {
      expect(input).toBe('https://oauth2.googleapis.com/token');
      const parameters = init!.body as URLSearchParams;
      expect(parameters.get('grant_type')).toBe('authorization_code');
      expect(parameters.get('code')).toBe('one-time-code');
      expect(parameters.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'));
      expect(createHash('sha256').update(parameters.get('code_verifier')!).digest('base64url')).toBe(
        authorization.searchParams.get('code_challenge'),
      );
      return Response.json({
        access_token: 'short-lived',
        refresh_token: 'long-lived',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: ANDROID_PUBLISHER_SCOPE,
      });
    }) as unknown as typeof fetch;
    await authenticateGoogle(
      { clientId: 'client', clientSecret: 'client-secret' },
      async (url) => {
        authorization = new URL(url);
        expect(authorization.searchParams.get('access_type')).toBe('offline');
        expect(authorization.searchParams.get('scope')).toBe(
          [ANDROID_PUBLISHER_SCOPE, consoleScope].filter(Boolean).join(' '),
        );
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        expect(callback.hostname).toBe('127.0.0.1');
        callback.search = new URLSearchParams({ code: 'one-time-code', state: 'wrong' }).toString();
        expect((await fetch(callback)).status).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
        callback.searchParams.set('state', authorization.searchParams.get('state')!);
        expect((await fetch(callback)).status).toBe(200);
        expect((await fetch(callback)).status).toBe(400);
      },
      store,
      fetcher,
      consoleScope,
    );
    const file = path.join(directory, (await readdir(directory))[0]!);
    const content = await readFile(file, 'utf8');
    expect(content).toContain('long-lived');
    expect(content).not.toContain('short-lived');
    expect(content).not.toContain('one-time-code');
  });

  it('refreshes locally and keeps a rotated refresh token', async () => {
    await store.put('googlePlayOAuth', 'default', {
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'old',
    });
    const fetcher = jest.fn(async (_input: unknown, init?: RequestInit) => {
      expect((init!.body as URLSearchParams).get('refresh_token')).toBe('old');
      return Response.json({
        access_token: 'fresh',
        refresh_token: 'rotated',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }) as unknown as typeof fetch;
    expect(await savedGoogleAccessToken(store, fetcher)).toBe('fresh');
    expect((await store.get('googlePlayOAuth', 'default'))?.data.refreshToken).toBe('rotated');
  });

  it('preserves the old credential on token errors and suppresses provider bodies', async () => {
    await store.put('googlePlayOAuth', 'default', { clientId: 'client', refreshToken: 'old' });
    const fetcher = jest.fn(async () =>
      Response.json({ error: 'invalid_grant', error_description: 'SECRET' }, { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(savedGoogleAccessToken(store, fetcher)).rejects.toThrow('Run lim android play auth again');
    await expect(savedGoogleAccessToken(store, fetcher)).rejects.not.toThrow('SECRET');
    expect((await store.get('googlePlayOAuth', 'default'))?.data.refreshToken).toBe('old');
  });

  it('does not replace a credential when consent omits the refresh token', async () => {
    await store.put('googlePlayOAuth', 'default', { clientId: 'old-client', refreshToken: 'old' });
    const fetcher = jest.fn(async () =>
      Response.json({ access_token: 'access', expires_in: 3600, token_type: 'Bearer' }),
    ) as unknown as typeof fetch;
    await expect(
      authenticateGoogle(
        { clientId: 'client' },
        async (url) => {
          const auth = new URL(url);
          const callback = new URL(auth.searchParams.get('redirect_uri')!);
          callback.search = new URLSearchParams({
            state: auth.searchParams.get('state')!,
            code: 'code',
          }).toString();
          await fetch(callback);
        },
        store,
        fetcher,
      ),
    ).rejects.toThrow('no refresh token');
    expect((await store.get('googlePlayOAuth', 'default'))?.data.clientId).toBe('old-client');
  });
});
