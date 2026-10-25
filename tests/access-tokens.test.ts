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
            scopes: ['asset:*:read'],
            expiresAt: '2026-10-25T15:00:00Z',
          },
      );
    },
  });
  expect(client.accessTokens).toBeInstanceOf(AccessTokens);
  expect(client.scopedTokens).toBeInstanceOf(ScopedTokens);
  const body = { scopes: ['asset:*:read'], ttlSeconds: 900 };
  const current = await client.accessTokens.create(body);
  const legacy = await client.scopedTokens.create(body);
  expect(current.token).toBe(legacy.token);
  await client.accessTokens.revoke(current.id);
  expect(calls).toEqual([
    { path: '/v1/access_tokens', method: 'POST', body },
    { path: '/v1/scoped_tokens', method: 'POST', body },
    { path: '/v1/access_tokens/token-id', method: 'DELETE', body: undefined },
  ]);
});
