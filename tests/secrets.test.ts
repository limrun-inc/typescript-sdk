import Limrun from '../src';

const id = 'secret_01m7071h5qfavacqmm4mg23x1k';
const resource = `projects/123456/secrets/${id}`;
const metadata = { id, name: 'npm/token', type: 'generic', metadata: { registry: 'npm' } };
const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
function setup(grant = { resource, action: 'read', accessToken: 'google-token' }) {
  return new Limrun({
    apiKey: 'limrun-key',
    baseURL: 'https://api.example.test',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        url: url.pathname + url.search,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === '/v1/whoami') return Response.json({ organization: { id: 'org_test' } });
      if (url.pathname.endsWith('/access_tokens')) return Response.json(grant);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'GET' && url.pathname.endsWith('/secrets'))
        return Response.json({ secrets: [metadata] });
      return Response.json(metadata);
    },
  });
}
beforeEach(() => {
  calls.length = 0;
});

test('metadata methods use exact names and keep values out of Limrun requests', async () => {
  const c = setup();
  await c.secrets.create({ name: 'npm/token', type: 'generic' });
  await c.secrets.update('name/npm/token', { metadata: { registry: 'npm' } });
  expect(await c.secrets.get('name/npm/token', { organizationId: 'org_test' })).toEqual(metadata);
  await c.secrets.delete(id);
  expect(calls.map((c) => [c.method, c.url])).toEqual([
    ['POST', '/v1/secrets'],
    ['PATCH', '/v1/secrets/name%2Fnpm%2Ftoken'],
    ['GET', '/v1/organizations/org_test/secrets?nameFilter=npm%2Ftoken&limit=1'],
    ['GET', '/v1/whoami'],
    ['DELETE', `/v1/organizations/org_test/secrets/${id}`],
  ]);
});

test('read sends only a grant request to Limrun, checks CRC32C, and preserves bytes', async () => {
  const c = setup();
  const storageFetch: typeof fetch = jest.fn(async (input, init) => {
    expect(String(input)).toBe(`https://secretmanager.googleapis.com/v1/${resource}/versions/latest:access`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer google-token');
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    return Response.json({ payload: { data: btoa('123456789'), dataCrc32c: '3808858755' } });
  });
  expect(new TextDecoder().decode(await c.secrets.read('name/npm/token', { storageFetch }))).toBe(
    '123456789',
  );
  expect(calls).toEqual([
    { url: '/v1/secrets/access_tokens', method: 'POST', body: { target: 'name/npm/token', action: 'read' } },
  ]);
  await expect(
    c.secrets.read(id, {
      storageFetch: async () => Response.json({ payload: { data: 'AA==', dataCrc32c: '0' } }),
    }),
  ).rejects.toThrow('integrity');
});

test('write transfers value and checksum only to Google', async () => {
  const c = setup({ resource, action: 'write', accessToken: 'google-token' });
  await c.secrets.write(id, '123456789', {
    storageFetch: async (input, init) => {
      expect(String(input)).toBe(`https://secretmanager.googleapis.com/v1/${resource}:addVersion`);
      expect(JSON.parse(String(init?.body))).toEqual({
        payload: { data: btoa('123456789'), dataCrc32c: '3808858755' },
      });
      return Response.json({});
    },
  });
  expect(JSON.stringify(calls)).not.toContain('123456789');
  expect(calls[0]?.body).toEqual({ target: id, action: 'write' });
});

test.each([
  { resource: 'https://attacker.test', action: 'read' },
  { resource: `${resource}/../other`, action: 'read' },
  { resource, action: 'write' },
  { resource: 'projects/123/secrets/secret_01m7071h5qfavacqmm4mg23x1m', action: 'read' },
])('rejects invalid grants before sending a provider credential', async (grant) => {
  const storageFetch = jest.fn();
  await expect(
    setup({ ...grant, accessToken: 'google-token' }).secrets.read(id, { storageFetch }),
  ).rejects.toThrow('Invalid secret access grant');
  expect(storageFetch).not.toHaveBeenCalled();
});

test('provider errors and network failures do not disclose credentials or response bodies', async () => {
  const c = setup();
  await expect(
    c.secrets.read(id, { storageFetch: async () => new Response('private-value', { status: 403 }) }),
  ).rejects.toThrow('Secret storage request failed (HTTP 403).');
  await expect(
    c.secrets.read(id, {
      storageFetch: async () => {
        throw new Error('google-token');
      },
    }),
  ).rejects.toThrow('Secret storage request failed.');
});

test('rejects empty and oversized writes before requesting grants', async () => {
  const c = setup();
  await expect(c.secrets.write(id, '')).rejects.toThrow('64 KiB');
  await expect(c.secrets.write(id, new Uint8Array(65537))).rejects.toThrow('64 KiB');
  expect(calls).toHaveLength(0);
});
