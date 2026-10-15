import Limrun from '@limrun/api';
import { VERSION } from '@limrun/api/version';

describe('application User-Agent', () => {
  const sdkUserAgent = `Limrun/JS ${VERSION}`;
  const client = new Limrun({ apiKey: 'test-key', userAgent: 'agent-device-cli/0.21.28' });

  test('prepends the application identifier on instance creation requests', async () => {
    const fetchMock = jest.fn(async (_url: unknown, _init?: RequestInit) => {
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    await client.withOptions({ fetch: fetchMock }).iosInstances.create({ wait: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/v1/ios_instances?wait=true');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('user-agent')).toBe(`agent-device-cli/0.21.28 ${sdkUserAgent}`);
  });

  test.each([undefined, '', '   '])('keeps the SDK default for %p', async (userAgent) => {
    const { req } = await new Limrun({ apiKey: 'test-key', userAgent }).buildRequest({
      path: '/v1/ios_instances',
      method: 'post',
    });
    expect(req.headers.get('user-agent')).toBe(sdkUserAgent);
  });

  test('trims surrounding whitespace while preserving multiple product identifiers', async () => {
    const { req } = await client
      .withOptions({ userAgent: '  my-app/1.0 agent-device-cli/0.21.28  ' })
      .buildRequest({ path: '/v1/ios_instances', method: 'post' });
    expect(req.headers.get('user-agent')).toBe(`my-app/1.0 agent-device-cli/0.21.28 ${sdkUserAgent}`);
  });

  test('withOptions can replace or clear the application identifier without changing the original', async () => {
    for (const [c, expected] of [
      [client.withOptions({ userAgent: 'other-app/2' }), `other-app/2 ${sdkUserAgent}`],
      [client.withOptions({ userAgent: undefined }), sdkUserAgent],
      [client, `agent-device-cli/0.21.28 ${sdkUserAgent}`],
    ] as const) {
      const { req } = await c.buildRequest({ path: '/v1/ios_instances', method: 'post' });
      expect(req.headers.get('user-agent')).toBe(expected);
    }
  });

  test('defaultHeaders can still replace the full User-Agent', async () => {
    const { req } = await client
      .withOptions({ defaultHeaders: { 'User-Agent': 'custom-client/1' } })
      .buildRequest({ path: '/v1/ios_instances', method: 'post' });
    expect(req.headers.get('user-agent')).toBe('custom-client/1');
  });

  test.each(['custom-request/1', null])('request headers can still override with %p', async (userAgent) => {
    const { req } = await client.buildRequest({
      path: '/v1/ios_instances',
      method: 'post',
      headers: { 'user-agent': userAgent },
    });
    expect(req.headers.get('user-agent')).toBe(userAgent);
  });
});
