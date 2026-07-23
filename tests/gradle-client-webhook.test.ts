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

describe('gradle client build-finish webhook', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('serializes webhook in gradlebuild exec request', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://gradle.example.test/exec') {
        return jsonResponse({ execId: 'build-1' });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const gradle = await client.gradleInstances.createClient({
      apiUrl: 'https://gradle.example.test',
      token: 'gradle-token',
    });

    const result = await gradle.gradlebuild({
      tasks: ['assembleDebug'],
      webhook: {
        url: 'https://ci.example.com/hooks/limrun',
        headers: { Authorization: 'Bearer hook-secret' },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'gradlebuild',
      tasks: ['assembleDebug'],
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
      if (String(input) === 'https://gradle.example.test/exec') {
        return jsonResponse({ execId: 'build-2' });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const gradle = await client.gradleInstances.createClient({
      apiUrl: 'https://gradle.example.test',
      token: 'gradle-token',
    });

    const result = await gradle.gradlebuild({ tasks: ['assembleDebug'] });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'gradlebuild',
      tasks: ['assembleDebug'],
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
