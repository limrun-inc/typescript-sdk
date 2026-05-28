import Limrun from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

describe('xcode client simulator helpers', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('gets simulator status from limbuild', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://xcode.example.test/simulator') {
        return jsonResponse({
          attached: true,
          simulator: {
            apiUrl: 'https://sim.example.test/v1/ios_123/api',
            iosInstanceId: 'ios_123',
          },
          latestBuild: {
            buildId: 'build-1',
            sdk: 'iphonesimulator',
            installState: 'installedOnAttachedSimulator',
          },
        });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });
    const status = await xcode.getSimulator();

    expect(status.simulator?.iosInstanceId).toBe('ios_123');
    expect(status.latestBuild?.installState).toBe('installedOnAttachedSimulator');
    expect(calls[0]?.init?.method).toBe('GET');
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer xcode-token');
  });

  test('attachSimulator returns install result and posts simulator credentials', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://xcode.example.test/simulator' && init?.method === 'POST') {
        return jsonResponse({
          attached: true,
          alreadyAttached: false,
          installedLastBuild: true,
          latestBuild: {
            buildId: 'build-2',
            sdk: 'iphonesimulator',
            installState: 'installedOnAttachedSimulator',
          },
        });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });
    const result = await xcode.attachSimulator({
      apiUrl: 'https://sim.example.test/v1/ios_123/api',
      token: 'sim-token',
    });

    expect(result.installedLastBuild).toBe(true);
    expect(result.latestBuild?.buildId).toBe('build-2');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      apiUrl: 'https://sim.example.test/v1/ios_123/api',
      token: 'sim-token',
    });
  });

  test('getSimulator rejects empty success response', async () => {
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo) => {
      if (String(input) === 'https://xcode.example.test/simulator') {
        return emptyResponse();
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });

    await expect(xcode.getSimulator()).rejects.toThrow('GET /simulator returned an empty response');
  });

  test('attachSimulator rejects empty success response', async () => {
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      if (String(input) === 'https://xcode.example.test/simulator' && init?.method === 'POST') {
        return emptyResponse();
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });

    await expect(
      xcode.attachSimulator({
        apiUrl: 'https://sim.example.test/v1/ios_123/api',
        token: 'sim-token',
      }),
    ).rejects.toThrow('POST /simulator returned an empty response');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(): Response {
  return new Response('', { status: 200 });
}
