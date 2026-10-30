import Limrun from '../src';

test.each(['iosInstances', 'androidInstances', 'xcodeInstances', 'gradleInstances'] as const)(
  '%s exposes live permissions and conditionally replaces them',
  async (resource) => {
    const endpoint = resource.replace('Instances', '_instances');
    const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(`https://api.example/v1/${endpoint}/instance`);
      if (init?.method === 'GET') {
        return Response.json(
          { spec: { role: { permissions: ['asset:name/input:read'] } } },
          { headers: { ETag: '"42"' } },
        );
      }
      expect(init?.method).toBe('PATCH');
      expect(new Headers(init?.headers).get('If-Match')).toBe('"42"');
      expect(new Headers(init?.headers).get('Accept')).toBe('*/*');
      expect(JSON.parse(init?.body as string)).toEqual({ spec: { role: { permissions: [] } } });
      return new Response(null, { status: 204 });
    });
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example', fetch: fetcher });
    const { data, response } = await client[resource].get('instance').withResponse();
    expect(data.spec.role?.permissions).toEqual(['asset:name/input:read']);
    await expect(
      client[resource].update('instance', {
        ifMatch: response.headers.get('etag')!,
        spec: { role: { permissions: [] } },
      }),
    ).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

test('a stale update surfaces 412 without replaying the stale permissions', async () => {
  const fetcher = jest.fn(async () => Response.json({ message: 'instance changed' }, { status: 412 }));
  const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example', fetch: fetcher });
  await expect(
    client.xcodeInstances.update('instance', { ifMatch: '"old"', spec: { role: { permissions: [] } } }),
  ).rejects.toMatchObject({ status: 412 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
