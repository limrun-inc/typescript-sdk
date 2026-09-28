import Limrun from '@limrun/api';
import { type XcodeInstanceCreateParamsWithSnapshot } from '@limrun/api';

const config = { key: 'myapp-pr51', restoreKeys: ['myapp-pr51', 'myapp-main'] };
const wireStatus = {
  config,
  restore: { phase: 'restored', matchedKey: 'myapp-main', matchKind: 'exact_hit' },
  save: { phase: 'published', cacheKey: 'myapp-pr51', bytes: 1024 },
};

function mockClient() {
  const fetch = jest.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(wireStatus), {
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_123' },
      }),
  );
  return { client: new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test', fetch }), fetch };
}

test.each(['snapshot', 'cache'] as const)(
  '%s create configuration uses the existing wire contract',
  async (name) => {
    const { client, fetch } = mockClient();
    const params: XcodeInstanceCreateParamsWithSnapshot = {
      wait: true,
      spec: { [name]: config, region: 'us-west' },
    };
    await client.xcodeInstances.create(params);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.test/v1/xcode_instances?wait=true');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      spec: { cache: config, region: 'us-west' },
    });
    expect(params.spec?.[name]).toBe(config);
    expect(Object.keys(params.spec!)).toEqual([name, 'region']);
  },
);

test('ambiguous create configuration fails before sending a request', () => {
  const { client, fetch } = mockClient();
  expect(() => client.xcodeInstances.create({ spec: { snapshot: config, cache: { key: 'other' } } })).toThrow(
    'Use either spec.snapshot or the legacy spec.cache, not both.',
  );
  expect(fetch).not.toHaveBeenCalled();
});

test('snapshot status maps the publication key and retains API response helpers', async () => {
  const { client, fetch } = mockClient();
  const { data, response } = await client.xcodeInstances.getSnapshot('sandbox_1').withResponse();
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.test/v1/xcode_instances/sandbox_1/cache');
  expect(data).toEqual({
    ...wireStatus,
    save: { phase: 'published', snapshotKey: 'myapp-pr51', bytes: 1024 },
  });
  expect(response.status).toBe(200);
  expect(await client.xcodeInstances.getCache('sandbox_1')).toEqual(wireStatus);
});

test.each(['bindSnapshotKey', 'bindCacheKey'] as const)(
  '%s binds the same saved workspace',
  async (method) => {
    const { client, fetch } = mockClient();
    const result = await client.xcodeInstances[method]('sandbox_1', 'myapp-pr51');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.test/v1/xcode_instances/sandbox_1/cache');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('PUT');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ key: 'myapp-pr51' });
    expect(result.save).toEqual({
      phase: 'published',
      [method === 'bindSnapshotKey' ? 'snapshotKey' : 'cacheKey']: 'myapp-pr51',
      bytes: 1024,
    });
  },
);
