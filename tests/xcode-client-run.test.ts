jest.mock('eventsource-client', () => ({
  createEventSource: jest.fn((options: { onMessage: (message: { event: string; data: string }) => void }) => {
    setTimeout(() => options.onMessage({ event: 'exitCode', data: '0' }), 0);
    return { close: jest.fn() };
  }),
}));

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
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
      env: ['API_ENV=development'],
      timeoutSeconds: 120,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'run',
      commandLine: 'make api',
      cwd: 'apps/api',
      env: ['API_ENV=development'],
      timeoutSeconds: 120,
    });
  });
  test('transmits only personal tool defaults to builds and commands', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lim-mise-client-'));
    const previous = process.env['MISE_GLOBAL_CONFIG_FILE'];
    const bodies: Array<{ env: string[] }> = [];
    try {
      const config = path.join(dir, 'config.toml');
      await fs.writeFile(config, '[tools]\nnode="24.5.0"\nruby="3.3.7"\n[env]\nTOKEN="local secret"\n');
      process.env['MISE_GLOBAL_CONFIG_FILE'] = config;
      nodeProxyTransport.fetch = jest.fn(async (_input: RequestInfo, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return jsonResponse({ execId: `request-${bodies.length}` });
      });
      const api = new Limrun({ apiKey: 'key' });
      const xcode = await api.xcodeInstances.createClient({
        apiUrl: 'https://xcode.example.test',
        token: 'token',
      });
      await xcode.run('node --version', { env: ['EXAMPLE=yes'] });
      await xcode.xcodebuild(undefined, { env: ['EXAMPLE=yes'] });
      for (const body of bodies) {
        expect(body.env).toEqual(['EXAMPLE=yes', 'LIMRUN_MISE_DEFAULTS={"node":"24.5.0","ruby":"3.3.7"}']);
        expect(JSON.stringify(body)).not.toContain('local secret');
      }
      expect(bodies).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env['MISE_GLOBAL_CONFIG_FILE'];
      else process.env['MISE_GLOBAL_CONFIG_FILE'] = previous;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
