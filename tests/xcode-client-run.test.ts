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

describe('xcode client run', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('serializes command options in the limbuild exec request', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://xcode.example.test/exec') {
        return jsonResponse({ execId: 'run-1' });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });
    const result = await xcode.run('make api', {
      cwd: 'apps/api',
      env: { API_ENV: 'development' },
      timeoutSeconds: 120,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'run',
      commandLine: 'make api',
      cwd: 'apps/api',
      env: { API_ENV: 'development' },
      timeoutSeconds: 120,
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
