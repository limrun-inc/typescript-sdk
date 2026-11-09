import Limrun from '../src';

/** A client whose list calls answer with `body`, and the URL each call requested. */
function clientReturning(body: unknown) {
  const requested: { url?: URL } = {};
  const client = new Limrun({
    apiKey: 'test-key',
    baseURL: 'https://api.example.test',
    maxRetries: 0,
    fetch: async (input) => {
      requested.url = new URL(String(input));
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, requested };
}

describe('session artifact resources', () => {
  test.each([
    ['androidInstances', 'android_123', '/v1/android_instances/android_123/session_artifacts'],
    ['iosInstances', 'ios_123', '/v1/ios_instances/ios_123/session_artifacts'],
  ] as const)('lists network logs from %s', async (resourceName, id, pathname) => {
    const { client, requested } = clientReturning([
      {
        id: 'network-1',
        kind: 'networkLog',
        tunnelId: 'tunnel-1',
        selectors: ['*.example.test'],
        downloadUrl: 'https://download.example.test/network-1.har',
      },
    ]);

    const artifacts = await client[resourceName].listSessionArtifacts(id, 'networkLog');

    expect(requested.url?.pathname).toBe(pathname);
    expect(requested.url?.searchParams.get('kind')).toBe('networkLog');
    expect(artifacts[0]).toMatchObject({
      kind: 'networkLog',
      tunnelId: 'tunnel-1',
      selectors: ['*.example.test'],
    });
  });

  test('lists iOS performance captures as their own kind', async () => {
    const { client, requested } = clientReturning([
      { id: 'perf-1', kind: 'performance', downloadUrl: 'https://download.example.test/perf-1.jsonl' },
    ]);

    const captures = await client.iosInstances.listPerformanceCaptures('ios_123');

    expect(requested.url?.pathname).toBe('/v1/ios_instances/ios_123/session_artifacts');
    expect(requested.url?.searchParams.get('kind')).toBe('performance');
    expect(captures[0]).toMatchObject({ id: 'perf-1', kind: 'performance' });
  });
});
