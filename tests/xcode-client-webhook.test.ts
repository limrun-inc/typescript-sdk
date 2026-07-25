jest.mock('eventsource-client', () => ({
  createEventSource: jest.fn((options: { onMessage: (message: { event: string; data: string }) => void }) => {
    setTimeout(() => options.onMessage({ event: 'exitCode', data: '0' }), 0);
    return { close: jest.fn() };
  }),
}));

import Limrun from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';
import { createEventSource } from 'eventsource-client';

const originalFetch = nodeProxyTransport.fetch;

describe('xcode client build-finish webhook', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('serializes webhook in limbuild exec request', async () => {
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
        webhook: {
          url: 'https://ci.example.com/hooks/limrun',
          headers: { Authorization: 'Bearer hook-secret' },
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'xcodebuild',
      xcodebuild: { scheme: 'Scripty' },
      webhook: {
        url: 'https://ci.example.com/hooks/limrun',
        headers: { Authorization: 'Bearer hook-secret' },
      },
    });
  });

  test('omits webhook when not configured', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://xcode.example.test/exec') {
        return jsonResponse({ execId: 'build-2' });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });

    const result = await xcode.xcodebuild({ scheme: 'Scripty' });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'xcodebuild',
      xcodebuild: { scheme: 'Scripty' },
    });
  });

  test('detach returns after exec starts without opening the event stream', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://xcode.example.test/exec') {
        return jsonResponse({ execId: 'build-detached' });
      }
      throw new Error(`unexpected request: ${input}`);
    });
    jest.mocked(createEventSource).mockClear();

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });

    const process = xcode.xcodebuild(
      { scheme: 'Scripty' },
      { webhook: { url: 'https://ci.example.com/hooks/limrun' } },
    );
    await expect(process.detach()).resolves.toBe('build-detached');

    expect(createEventSource).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
