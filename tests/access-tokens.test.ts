import Limrun from '@limrun/api';
import { AccessTokens } from '@limrun/api/resources/access-tokens';
import { ScopedTokens } from '@limrun/api/resources/scoped-tokens';

test('canonical and legacy token clients keep their routes and share credential payloads', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client = new Limrun({
    apiKey: 'existing-key',
    baseURL: 'https://api.example.test',
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer existing-key');
      calls.push({
        path: new URL(input.toString()).pathname,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return Response.json(
        init?.method === 'DELETE' ?
          { status: 'OK' }
        : {
            id: 'token-id',
            token: 'signed-value',
            permissions: ['asset:*:read'],
            scopes: ['asset:*:read'],
            expiresAt: '2026-10-25T15:00:00Z',
          },
      );
    },
  });
  expect(client.accessTokens).toBeInstanceOf(AccessTokens);
  expect(client.scopedTokens).toBeInstanceOf(ScopedTokens);
  const body = { permissions: ['asset:*:read'], ttlSeconds: 900 };
  const legacyBody = { scopes: ['asset:*:read'], ttlSeconds: 900 };
  const current = await client.accessTokens.create(body);
  const legacy = await client.scopedTokens.create(legacyBody);
  expect(current.token).toBe(legacy.token);
  await client.accessTokens.revoke(current.id);
  expect(calls).toEqual([
    { path: '/v1/access_tokens', method: 'POST', body },
    { path: '/v1/access_tokens', method: 'POST', body },
    { path: '/v1/access_tokens/token-id', method: 'DELETE', body: undefined },
  ]);
});

test('the hosted API mints and revokes access tokens at the token service', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const client = new Limrun({
    apiKey: 'existing-key',
    fetch: async (input, init) => {
      calls.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      // The token service returns no deprecated scopes field.
      return Response.json(
        init?.method === 'DELETE' ?
          { status: 'OK' }
        : {
            id: 'token-id',
            token: 'signed-value',
            permissions: ['asset:*:read'],
            expiresAt: '2026-10-25T15:00:00Z',
          },
      );
    },
  });
  const current = await client.accessTokens.create({ permissions: ['asset:*:read'] });
  const legacy = await client.scopedTokens.create({ scopes: ['asset:*:read'], ttlSeconds: 900 });
  expect(current.scopes).toEqual(['asset:*:read']);
  expect(legacy.scopes).toEqual(['asset:*:read']);
  await client.accessTokens.revoke(current.id);
  expect(calls).toEqual([
    {
      url: 'https://sts.limrun.com/v1/access_tokens',
      method: 'POST',
      body: { permissions: ['asset:*:read'] },
    },
    {
      url: 'https://sts.limrun.com/v1/access_tokens',
      method: 'POST',
      body: { permissions: ['asset:*:read'], ttlSeconds: 900 },
    },
    { url: 'https://sts.limrun.com/v1/access_tokens/token-id', method: 'DELETE', body: undefined },
  ]);
});

test('permissions and the deprecated scopes must agree', async () => {
  const client = new Limrun({ apiKey: 'existing-key', fetch: async () => Response.json({}) });
  expect(() =>
    client.accessTokens.create({ permissions: ['asset:*:read'], scopes: ['asset:*:all'] }),
  ).toThrow('permissions and the deprecated scopes must name the same permissions');
});
