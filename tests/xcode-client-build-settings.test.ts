jest.mock('eventsource-client', () => ({
  createEventSource: jest.fn((options: { onMessage: (message: { event: string; data: string }) => void }) => {
    setTimeout(() => options.onMessage({ event: 'exitCode', data: '0' }), 0);
    return { close: jest.fn() };
  }),
}));

import Limrun from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

describe('xcode client build settings', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('serializes buildSettings in limbuild exec request', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://xcode.example.test/exec') {
        return jsonResponse({ execId: 'build-1' });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });

    const result = await xcode.xcodebuild(
      { scheme: 'Scripty' },
      {
        gitInit: true,
        hotReload: true,
        reactNative: { expoNoClean: true },
        buildSettings: {
          SWIFT_ACTIVE_COMPILATION_CONDITIONS: '$(inherited) LIMRUN',
          APP_CONFIG_DEV_LOGIN_SECRET: 'abc=def',
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'xcodebuild',
      xcodebuild: { scheme: 'Scripty' },
      gitInit: true,
      hotReload: true,
      reactNative: { expoNoClean: true },
      buildSettings: {
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: '$(inherited) LIMRUN',
        APP_CONFIG_DEV_LOGIN_SECRET: 'abc=def',
      },
    });
  });

  test('leaves hotReload out of the request unless it is on', async () => {
    const bodies: unknown[] = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      if (String(input) === 'https://xcode.example.test/exec') {
        bodies.push(JSON.parse(init?.body as string));
        return jsonResponse({ execId: 'build-1' });
      }
      throw new Error(`unexpected request: ${input}`);
    });
    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });

    await xcode.xcodebuild({ scheme: 'Scripty' }, { hotReload: false });

    expect(bodies).toEqual([{ command: 'xcodebuild', xcodebuild: { scheme: 'Scripty' } }]);
  });

  test.each([
    {
      settings: { configuration: 'Release' as const },
      error: /hotReload is only supported for Debug builds/,
    },
    { settings: { sdk: 'iphoneos' as const }, error: /hotReload requires the iphonesimulator sdk/ },
    { settings: { sdk: 'watchsimulator' as const }, error: /hotReload requires the iphonesimulator sdk/ },
  ])('rejects hotReload with $settings before sending a request', async ({ settings, error }) => {
    nodeProxyTransport.fetch = jest.fn();
    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });

    expect(() => xcode.xcodebuild(settings, { hotReload: true })).toThrow(error);
    expect(nodeProxyTransport.fetch).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
