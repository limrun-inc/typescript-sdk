import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaystorePublishError, publishToPlaystore } from './publish';

function mockFetch(status: number, body: string) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publishToPlaystore', () => {
  it('posts to the publish path with auth and org headers and returns the versionCode', async () => {
    const fetchMock = mockFetch(200, JSON.stringify({ versionCode: 42 }));
    const result = await publishToPlaystore({
      registryApiUrl: 'https://registry-staging.limrun.dev',
      token: 'limrun-token',
      organizationId: 'org_x',
      accessToken: 'google-token',
      packageName: 'com.example.app',
      assetName: 'app-release.aab',
    });
    expect(result.versionCode).toBe(42);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://registry-staging.limrun.dev/android/playstore/publish');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer limrun-token');
    expect(headers['X-Limrun-Organization']).toBe('org_x');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      accessToken: 'google-token',
      packageName: 'com.example.app',
      assetName: 'app-release.aab',
    });
  });

  it('surfaces the registry error message and code', async () => {
    mockFetch(409, JSON.stringify({ message: 'Version code 2 has already been used', code: 'versionCodeExists' }));
    const error = await publishToPlaystore({
      registryApiUrl: 'https://registry-staging.limrun.dev',
      accessToken: 'google-token',
      packageName: 'com.example.app',
      assetName: 'app-release.aab',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlaystorePublishError);
    const publishError = error as PlaystorePublishError;
    expect(publishError.code).toBe('versionCodeExists');
    expect(publishError.status).toBe(409);
    expect(publishError.message).toContain('already been used');
  });

  it('handles non-JSON error bodies', async () => {
    mockFetch(502, '<html>bad gateway</html>');
    const error = await publishToPlaystore({
      registryApiUrl: 'https://registry-staging.limrun.dev',
      accessToken: 'google-token',
      packageName: 'com.example.app',
      assetId: 'asset_1',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlaystorePublishError);
    expect((error as PlaystorePublishError).message).toContain('HTTP 502');
  });
});
