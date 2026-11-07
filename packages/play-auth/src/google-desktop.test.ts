// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { openGoogleCallback } from './internal/google-callback';
import { authenticateGoogleDesktop, refreshGoogleAccessToken } from './google-desktop';

describe('Google loopback callback', () => {
  it('rejects callbacks for another path and handles denied consent', async () => {
    const callback = await openGoogleCallback('state');
    try {
      expect((await fetch(callback.redirectUri.replace('/callback', '/other'))).status).toBe(404);
      expect((await fetch(`${callback.redirectUri}?state=state&error=access_denied`)).status).toBe(400);
      await expect(callback.code).rejects.toThrow('denied or cancelled');
    } finally {
      callback.close();
    }
  });

  it('times out and can close its listener', async () => {
    const callback = await openGoogleCallback('state', 10);
    try {
      await expect(callback.code).rejects.toThrow('timed out');
    } finally {
      callback.close();
    }
    await expect(fetch(callback.redirectUri)).rejects.toThrow();
  });

  it('cancels even when the browser opener never resolves', async () => {
    const controller = new AbortController();
    let callback = '';
    await expect(
      authenticateGoogleDesktop({
        clientId: 'client',
        signal: controller.signal,
        openBrowser: (url) => {
          callback = new URL(url).searchParams.get('redirect_uri')!;
          controller.abort();
          return new Promise(() => {});
        },
      }),
    ).rejects.toThrow('cancelled');
    await expect(fetch(callback)).rejects.toThrow();
  });

  it('does not exchange credentials after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      refreshGoogleAccessToken({
        clientId: 'client',
        refreshToken: 'refresh',
        signal: controller.signal,
        fetch: fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a token without publishing scope or a usable expiry', async () => {
    for (const fields of [
      { scope: 'openid', expires_in: 3600 },
      { scope: undefined, expires_in: 0 },
    ]) {
      await expect(
        refreshGoogleAccessToken({
          clientId: 'client',
          refreshToken: 'refresh',
          fetch: vi
            .fn()
            .mockResolvedValue(Response.json({ access_token: 'access', token_type: 'Bearer', ...fields })),
        }),
      ).rejects.toThrow('publishing token');
    }
  });
});

it('rejects unsupported Console scopes before opening a browser', async () => {
  const openBrowser = vi.fn();
  await expect(
    authenticateGoogleDesktop({ clientId: 'client', openBrowser, consoleScope: 'openid' as never }),
  ).rejects.toThrow('Unsupported');
  expect(openBrowser).not.toHaveBeenCalled();
});
