jest.mock('eventsource-client', () => ({
  createEventSource: jest.fn((options: { onMessage: (message: { event: string; data: string }) => void }) => {
    setTimeout(() => options.onMessage({ event: 'exitCode', data: '0' }), 0);
    return { close: jest.fn() };
  }),
}));

import Limrun from '@limrun/api';
import { PrepareUnsupportedError } from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockTransport(info: unknown): Array<{ input: RequestInfo; init: RequestInit | undefined }> {
  const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    calls.push({ input, init });
    const url = String(input);
    if (url === 'https://xcode.example.test/info') {
      return jsonResponse(info);
    }
    if (url === 'https://xcode.example.test/exec') {
      return jsonResponse({ execId: 'build-1' });
    }
    throw new Error(`unexpected request: ${input}`);
  });
  return calls;
}

async function newXcodeClient() {
  const client = new Limrun({ apiKey: 'key' });
  return client.xcodeInstances.createClient({
    apiUrl: 'https://xcode.example.test',
    token: 'xcode-token',
  });
}

describe('xcode client prepare commands', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('serializes prepare when the daemon advertises the capability', async () => {
    const calls = mockTransport({ homeDir: '.limbuild-sandbox/home', capabilities: ['prepare', 'fresh'] });
    const xcode = await newXcodeClient();

    const result = await xcode.xcodebuild(
      { project: 'ios/SampleApp.xcodeproj', scheme: 'SampleApp' },
      { prepare: ['make project'] },
    );

    expect(result.exitCode).toBe(0);
    const execCall = calls.find((c) => String(c.input).endsWith('/exec'));
    expect(execCall).toBeDefined();
    expect(JSON.parse(execCall?.init?.body as string)).toEqual({
      command: 'xcodebuild',
      xcodebuild: { project: 'ios/SampleApp.xcodeproj', scheme: 'SampleApp' },
      prepare: ['make project'],
    });
  });

  test('rejects with PrepareUnsupportedError before /exec on an old daemon', async () => {
    const calls = mockTransport({ homeDir: '.limbuild-sandbox/home' });
    const xcode = await newXcodeClient();

    await expect(xcode.xcodebuild({ scheme: 'SampleApp' }, { prepare: ['make project'] })).rejects.toThrow(
      PrepareUnsupportedError,
    );
    expect(calls.some((c) => String(c.input).endsWith('/exec'))).toBe(false);
  });

  test('plain builds neither call /info nor include prepare', async () => {
    const calls = mockTransport({ homeDir: '.limbuild-sandbox/home' });
    const xcode = await newXcodeClient();

    const result = await xcode.xcodebuild({ scheme: 'SampleApp' });

    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => String(c.input).endsWith('/info'))).toBe(false);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'xcodebuild',
      xcodebuild: { scheme: 'SampleApp' },
    });
  });

  test('rejects empty prepare entries client-side', async () => {
    mockTransport({ homeDir: '.limbuild-sandbox/home', capabilities: ['prepare'] });
    const xcode = await newXcodeClient();

    await expect(async () => xcode.xcodebuild({ scheme: 'SampleApp' }, { prepare: ['  '] })).rejects.toThrow(
      'prepare commands must be non-empty strings',
    );
  });
});
