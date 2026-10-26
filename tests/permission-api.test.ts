import Limrun, { assetPermission, assetScope } from '../src';

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
      expect(JSON.parse(init?.body as string)).toEqual({ spec: { delegatedPermissions: [] } });
      return Response.json({});
    });
    const client = new Limrun({ apiKey: 'explicit', baseURL: 'https://api.example', fetch: fetcher });
    const resources = {
      android: client.androidInstances,
      ios: client.iosInstances,
      xcode: client.xcodeInstances,
      gradle: client.gradleInstances,
    };
    await resources[platform].create({ spec: { delegatedPermissions: [] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test('assetScope remains compatible with assetPermission', () => {
  expect(assetPermission('name/result.apk', 'upload')).toBe('asset:name/result.apk:upload');
  expect(assetScope('name/result.apk', 'upload')).toBe(assetPermission('name/result.apk', 'upload'));
});

test('asset metadata uses PATCH and icons use upload URLs', async () => {
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Response.json({
      signedUploadUrl: 'https://storage.example/bundle',
      iconPutUrl: 'https://storage.example/icon',
    });
  });
  const lim = new Limrun({ apiKey: 'explicit', baseURL: 'https://api.example', fetch: fetcher });
  const id = 'asset_01h455vb4pex5vsknk084sn02q';
  await lim.assets.update(id, { bundleIdentifier: 'com.example.app', targetSdk: 'iphoneos' });
  const urls = await lim.assets.createUploadURL(id, { icon: true });
  expect(urls.iconPutUrl).toBe('https://storage.example/icon');
  expect(urls.iconUrl).toBeUndefined();
  await lim.assets.createUploadURL(id);
  expect(calls).toEqual([
    {
      url: `https://api.example/v1/assets/${id}`,
      method: 'PATCH',
      body: { bundleIdentifier: 'com.example.app', targetSdk: 'iphoneos' },
    },
    { url: `https://api.example/v1/assets/${id}/upload_urls?icon=true`, method: 'POST', body: undefined },
    { url: `https://api.example/v1/assets/${id}/upload_urls`, method: 'POST', body: undefined },
  ]);
});
