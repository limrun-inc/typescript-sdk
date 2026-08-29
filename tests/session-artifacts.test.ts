import Limrun from '../src';

describe('session artifact resources', () => {
  test.each([
    ['androidInstances', 'android_123', '/v1/android_instances/android_123/session_artifacts'],
    ['iosInstances', 'ios_123', '/v1/ios_instances/ios_123/session_artifacts'],
  ] as const)('lists network logs from %s', async (resourceName, id, pathname) => {
    let requestedURL: URL | undefined;
    const client = new Limrun({
      apiKey: 'test-key',
      baseURL: 'https://api.example.test',
      maxRetries: 0,
      fetch: async (input) => {
        requestedURL = new URL(String(input));
        return new Response(
          JSON.stringify([
            {
              id: 'network-1',
              kind: 'networkLog',
              tunnelId: 'tunnel-1',
              selectors: ['*.example.test'],
              downloadUrl: 'https://download.example.test/network-1.har',
            },
          ]),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const artifacts = await client[resourceName].listSessionArtifacts(id, { kind: 'networkLog' });

    expect(requestedURL?.pathname).toBe(pathname);
    expect(requestedURL?.searchParams.get('kind')).toBe('networkLog');
    expect(artifacts[0]).toMatchObject({
      kind: 'networkLog',
      tunnelId: 'tunnel-1',
      selectors: ['*.example.test'],
    });
  });
});
