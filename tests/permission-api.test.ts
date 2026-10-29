import Limrun from '../src';

test('access tokens send permissions and preserve the deprecated scopes API', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body as string) });
    return Response.json({
      id: 'id',
      token: 'token',
      permissions: ['asset:*:read'],
      scopes: ['asset:*:read'],
      expiresAt: '2026-10-26T00:00:00Z',
    });
  });
  const client = new Limrun({ apiKey: 'explicit', baseURL: 'https://api.example', fetch: fetcher });
  const canonical = await client.accessTokens.create({ permissions: ['asset:*:read'] });
  const legacy = await client.scopedTokens.create({ scopes: ['asset:*:read'] });
  expect(canonical.permissions).toEqual(legacy.scopes);
  expect(calls).toEqual([
    { url: 'https://api.example/v1/access_tokens', body: { permissions: ['asset:*:read'] } },
    { url: 'https://api.example/v1/scoped_tokens', body: { scopes: ['asset:*:read'] } },
  ]);
});

test.each(['android', 'ios', 'xcode', 'gradle'] as const)(
  '%s creates serialize explicit empty delegated permissions',
  async (platform) => {
    const fetcher = jest.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ spec: { role: { permissions: [] } } });
      return Response.json({});
    });
    const client = new Limrun({ apiKey: 'explicit', baseURL: 'https://api.example', fetch: fetcher });
    const resources = {
      android: client.androidInstances,
      ios: client.iosInstances,
      xcode: client.xcodeInstances,
      gradle: client.gradleInstances,
    };
    await resources[platform].create({ spec: { role: { permissions: [] } } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test('asset metadata uses PATCH and icons use upload URLs', async () => {
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (init?.method === 'PATCH') {
      expect(new Headers(init.headers).get('Accept')).toBe('*/*');
      return new Response(null, { status: 204 });
    }
    return Response.json({
      signedUploadUrl: 'https://storage.example/bundle',
      signedIconUploadUrl: 'https://storage.example/icon',
      md5: 'existing-md5',
    });
  });
  const lim = new Limrun({ apiKey: 'explicit', baseURL: 'https://api.example', fetch: fetcher });
  const id = 'asset_01h455vb4pex5vsknk084sn02q';
  await lim.assets.update(id, { bundleIdentifier: 'com.example.app', targetSdk: 'iphoneos' });
  const urls = await lim.assets.createUploadURL(id);
  expect(urls.signedUploadUrl).toBe('https://storage.example/bundle');
  expect(urls.signedIconUploadUrl).toBe('https://storage.example/icon');
  expect(urls.iconUrl).toBeUndefined();
  expect(urls.md5).toBe('existing-md5');
  expect(calls).toEqual([
    {
      url: `https://api.example/v1/assets/${id}`,
      method: 'PATCH',
      body: { bundleIdentifier: 'com.example.app', targetSdk: 'iphoneos' },
    },
    { url: `https://api.example/v1/assets/${id}/upload_urls`, method: 'GET', body: undefined },
  ]);
});
