import Limrun, { XcodeSelectionUnsupportedError } from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

const xcode27 = {
  major: '27',
  version: '27.0',
  build: '27A5252f',
  versionKey: '27.0.0.27A5252f',
  developerDir: '/Applications/Xcode-27.0.app/Contents/Developer',
  nodeDefault: false,
};

async function xcodeClient() {
  const client = new Limrun({ apiKey: 'key' });
  return client.xcodeInstances.createClient({ apiUrl: 'https://xcode.example.test', token: 'xcode-token' });
}

describe('xcode client Xcode selection helpers', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('getXcode reads the binding and the installed list', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse({ bound: xcode27, installed: [xcode27] });
    });
    const status = await (await xcodeClient()).getXcode();
    expect(status.bound.major).toBe('27');
    expect(String(calls[0]?.input)).toBe('https://xcode.example.test/xcode');
    expect(calls[0]?.init?.method).toBe('GET');
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer xcode-token');
  });

  test('setXcode posts the major and returns the result', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse({ bound: xcode27, alreadyBound: false, derivedDataReset: true });
    });
    const result = await (await xcodeClient()).setXcode('27');
    expect(result.derivedDataReset).toBe(true);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ version: '27' });
  });

  test('a 404 means the daemon predates selection, not a missing instance', async () => {
    nodeProxyTransport.fetch = jest.fn(async () => new Response('not found', { status: 404 }));
    await expect((await xcodeClient()).setXcode('27')).rejects.toBeInstanceOf(XcodeSelectionUnsupportedError);
  });

  test('a refusal keeps its status and body for the CLI to phrase', async () => {
    nodeProxyTransport.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ message: 'cannot switch Xcode while a build or command is running' }), {
          status: 409,
        }),
    );
    await expect((await xcodeClient()).setXcode('27')).rejects.toMatchObject({
      status: 409,
      body: expect.stringContaining('cannot switch Xcode'),
    });
  });

  test('getInfo carries the bound Xcode when the daemon reports one', async () => {
    nodeProxyTransport.fetch = jest.fn(async () =>
      jsonResponse({ homeDir: '.limbuild-sandbox/home', xcode: xcode27 }),
    );
    const info = await (await xcodeClient()).getInfo();
    expect(info.xcode?.version).toBe('27.0');
    expect(info.homeDir).toBe('.limbuild-sandbox/home');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
