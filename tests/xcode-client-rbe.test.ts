import Limrun from '@limrun/api';
import { RbeUnsupportedError } from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo, RequestInit } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

const SHA256 = 'deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc';

/** Minimal BEP stream: targetCompleted -> default outputGroup -> namedSet -> .ipa file with a URI. */
function bep(uri: string, label = '//App:App', ipaName = 'App/App.ipa'): string {
  return [
    { id: { namedSet: { id: '0' } }, namedSetOfFiles: { files: [{ name: ipaName, uri }] } },
    {
      id: { targetCompleted: { label } },
      completed: { success: true, outputGroup: [{ name: 'default', fileSets: [{ id: '0' }] }] },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
}

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
    nodeProxyTransport.fetch = jest.fn(async () => new Response('boom', { status: 500 }));
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
        new Response(
          JSON.stringify({ state: 'running', frontendPort: 8980, xcodeVersion: '26.4.0.17E192' }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    const xcode = await rbeClient();
    await expect(xcode.startRbe()).resolves.toEqual({
      state: 'running',
      frontendPort: 8980,
      xcodeVersion: '26.4.0.17E192',
    });
  });

  test('installRbeBuildFromBep parses the digest and posts it, returning ipaName', async () => {
    let body: { ipaDigest?: { hash: string; sizeBytes: number }; target?: string } | undefined;
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      if (!String(input).endsWith('/rbe/install')) throw new Error(`unexpected request: ${input}`);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ installed: true, appName: 'SampleApp', syncDurationMs: 12 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const xcode = await rbeClient();
    const result = await xcode.installRbeBuildFromBep({
      bep: bep(`bytestream://host/blobs/${SHA256}/40960`),
      target: '//App:App',
    });
    expect(body?.ipaDigest).toEqual({ hash: SHA256, sizeBytes: 40960 });
    expect(body?.target).toBe('//App:App');
    expect(result).toMatchObject({ installed: true, appName: 'SampleApp', ipaName: 'App/App.ipa' });
  });

  test('installRbeBuildFromBep rejects a BLAKE3 digest before any network call', async () => {
    const fetchMock = jest.fn(async () => new Response('{}', { status: 200 }));
    nodeProxyTransport.fetch = fetchMock;
    const xcode = await rbeClient();
    await expect(
      xcode.installRbeBuildFromBep({
        bep: bep('bytestream://host/blobs/abcabcabcabcabcabcabcabcabcabcab/40960'),
        target: '//App:App',
      }),
    ).rejects.toThrow(/non-SHA256 digest|--digest_function=sha256/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
