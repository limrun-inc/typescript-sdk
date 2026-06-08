import Limrun from '@limrun/api';
import { RbeUnsupportedError } from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

describe('xcode client RBE helpers', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  async function rbeClient() {
    const client = new Limrun({ apiKey: 'key' });
    return client.xcodeInstances.createClient({
      apiUrl: 'https://eu-nl1-m14-lim8.example.test/v1/sandbox_euna_abc/xcode',
      token: 'xcode-token',
    });
  }

  test('startRbe maps a /rbe 404 to RbeUnsupportedError, not NotFoundError', async () => {
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo) =>
      String(input).endsWith('/rbe') ?
        new Response('404 page not found\n', { status: 404 })
      : (() => {
          throw new Error(`unexpected request: ${input}`);
        })(),
    );

    const xcode = await rbeClient();
    await expect(xcode.startRbe()).rejects.toBeInstanceOf(RbeUnsupportedError);
    // Crucially NOT a NotFoundError: that is what made the CLI mistake an
    // RBE-less instance for a vanished one and spin up replacement instances.
    await expect(xcode.startRbe()).rejects.not.toBeInstanceOf(Limrun.NotFoundError);
    await expect(xcode.startRbe()).rejects.toThrow(/Remote build execution is not available/);
  });

  test('a /rbe non-404 error stays a generic operation error', async () => {
    nodeProxyTransport.fetch = jest.fn(
      async () => new Response('boom', { status: 500 }),
    );
    const xcode = await rbeClient();
    await expect(xcode.getRbe()).rejects.not.toBeInstanceOf(RbeUnsupportedError);
    await expect(xcode.getRbe()).rejects.toThrow(/GET \/rbe failed: 500/);
  });

  test('getRbe and stopRbe also map a /rbe 404 to RbeUnsupportedError', async () => {
    // Proves the 404 mapping lives on readRbeResponse (shared by all verbs),
    // not just the POST path.
    nodeProxyTransport.fetch = jest.fn(async () => new Response('404 page not found\n', { status: 404 }));
    const xcode = await rbeClient();
    await expect(xcode.getRbe()).rejects.toBeInstanceOf(RbeUnsupportedError);
    await expect(xcode.stopRbe()).rejects.toBeInstanceOf(RbeUnsupportedError);
  });

  test('a 200 with an empty body is a clear error, not a JSON parse crash', async () => {
    nodeProxyTransport.fetch = jest.fn(async () => new Response('', { status: 200 }));
    const xcode = await rbeClient();
    await expect(xcode.getRbe()).rejects.toThrow(/returned an empty response/);
  });

  test('startRbe returns the parsed status on success', async () => {
    nodeProxyTransport.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ state: 'running', frontendPort: 8980, xcodeVersion: '26.4.0.17E192' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const xcode = await rbeClient();
    await expect(xcode.startRbe()).resolves.toEqual({
      state: 'running',
      frontendPort: 8980,
      xcodeVersion: '26.4.0.17E192',
    });
  });
});
