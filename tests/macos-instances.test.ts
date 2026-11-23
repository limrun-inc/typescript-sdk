import Limrun from '@limrun/api';

const instance = {
  metadata: { id: 'macos_eu_01h', organizationId: 'org', createdAt: '2026-11-23T00:00:00Z' },
  spec: { region: 'eu-north1', inactivityTimeout: '3m' },
  status: {
    state: 'ready',
    endpointWebSocketUrl: 'wss://node.example/v1/macos_eu_01h/endpointWebSocket',
    streamToken: 'stream',
  },
};

test('macOS instances use their own routes, query params and conditional update', async () => {
  const calls: Array<{ url: URL; method: string; headers: Headers; body: unknown }> = [];
  const client = new Limrun({
    apiKey: 'key',
    baseURL: 'https://api.example.test',
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (method === 'DELETE' || method === 'PATCH') return new Response(null, { status: 204 });
      if (method === 'GET' && url.pathname === '/v1/macos_instances') {
        // One page: the request for the page after it gets nothing.
        return Response.json(url.searchParams.has('startingAfter') ? [] : [instance]);
      }
      return Response.json(instance);
    },
  });

  const created = await client.macosInstances.create({
    wait: true,
    metadata: { labels: { env: 'test' } },
    spec: { inactivityTimeout: '5m', jurisdiction: 'eu' },
  });
  expect(created.status.endpointWebSocketUrl).toBe(instance.status.endpointWebSocketUrl);

  const listed = [];
  for await (const item of client.macosInstances.list({ state: 'ready', labelSelector: 'env=test' })) {
    listed.push(item.metadata.id);
  }
  expect(listed).toEqual(['macos_eu_01h']);

  await client.macosInstances.get('macos_eu_01h');
  await client.macosInstances.update('macos_eu_01h', { ifMatch: '"v1"', metadata: { labels: {} } });
  await client.macosInstances.delete('macos_eu_01h');

  expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
    'POST /v1/macos_instances',
    'GET /v1/macos_instances',
    'GET /v1/macos_instances',
    'GET /v1/macos_instances/macos_eu_01h',
    'PATCH /v1/macos_instances/macos_eu_01h',
    'DELETE /v1/macos_instances/macos_eu_01h',
  ]);
  expect(calls[0]!.url.searchParams.get('wait')).toBe('true');
  expect(calls[0]!.body).toEqual({
    metadata: { labels: { env: 'test' } },
    spec: { inactivityTimeout: '5m', jurisdiction: 'eu' },
  });
  expect(calls[1]!.url.searchParams.get('state')).toBe('ready');
  expect(calls[1]!.url.searchParams.get('labelSelector')).toBe('env=test');
  expect(calls[2]!.url.searchParams.get('startingAfter')).toBe('macos_eu_01h');
  expect(calls[4]!.headers.get('if-match')).toBe('"v1"');
  expect(calls[4]!.body).toEqual({ metadata: { labels: {} } });
});
