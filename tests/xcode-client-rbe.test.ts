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
});

// The upload rides fetchLongRequest (the daemon responds only after its
// server-side upload finishes, which can exceed plain fetch's 300s
// headersTimeout), so these tests mock that transport method.
describe('uploadLatestRbeBuild', () => {
  const originalFetchLongRequest = nodeProxyTransport.fetchLongRequest;
  afterEach(() => {
    nodeProxyTransport.fetchLongRequest = originalFetchLongRequest;
    jest.restoreAllMocks();
  });

  const uploadOk = JSON.stringify({ appName: 'MyApp.app', bundleId: 'com.example.myapp' });

  async function uploadClient() {
    const client = new Limrun({ apiKey: 'key' });
    const getOrCreate = jest.spyOn(client.assets, 'getOrCreate').mockResolvedValue({
      id: 'asset_1',
      name: 'preview/acme/app/pr-7-ios',
      signedUploadUrl: 'https://bucket.t3.storage.dev/put?sig=abc',
      signedDownloadUrl: 'https://bucket.t3.storage.dev/get?sig=def',
    } as never);
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://eu-nl1-m14-lim8.example.test/v1/sandbox_euna_abc/xcode',
      token: 'xcode-token',
    });
    return { xcode, getOrCreate };
  }

  test('signedUploadUrl form POSTs it to /rbe/upload and returns the daemon result', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo, _init?: RequestInit) =>
      String(input).endsWith('/rbe/upload') ?
        new Response(uploadOk, { status: 200 })
      : (() => {
          throw new Error(`unexpected request: ${input}`);
        })(),
    );
    nodeProxyTransport.fetchLongRequest = fetchMock;
    const { xcode } = await uploadClient();
    await expect(
      xcode.uploadLatestRbeBuild({ signedUploadUrl: 'https://bucket.t3.storage.dev/put?sig=xyz' }),
    ).resolves.toEqual({ appName: 'MyApp.app', bundleId: 'com.example.myapp' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      signedUploadUrl: 'https://bucket.t3.storage.dev/put?sig=xyz',
    });
  });

  test('assetName form mints the URL via assets.getOrCreate and returns its signedDownloadUrl', async () => {
    const fetchMock = jest.fn(
      async (_input: RequestInfo, _init?: RequestInit) => new Response(uploadOk, { status: 200 }),
    );
    nodeProxyTransport.fetchLongRequest = fetchMock;
    const { xcode, getOrCreate } = await uploadClient();
    await expect(
      xcode.uploadLatestRbeBuild({ assetName: 'preview/acme/app/pr-7-ios', ttl: '7d' }),
    ).resolves.toEqual({
      appName: 'MyApp.app',
      bundleId: 'com.example.myapp',
      signedDownloadUrl: 'https://bucket.t3.storage.dev/get?sig=def',
    });
    expect(getOrCreate).toHaveBeenCalledWith({ name: 'preview/acme/app/pr-7-ios', ttl: '7d' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      signedUploadUrl: 'https://bucket.t3.storage.dev/put?sig=abc',
    });
  });

  test('a 404 is a clear two-cause error, not RbeUnsupportedError', async () => {
    // A vanished instance and an old daemon without /rbe/upload 404
    // identically, so the error must name both causes; and an old daemon can
    // support /rbe, so the generic "RBE is not available" wording would
    // mislead.
    nodeProxyTransport.fetchLongRequest = jest.fn(
      async () => new Response('404 page not found\n', { status: 404 }),
    );
    const { xcode } = await uploadClient();
    const failed = xcode.uploadLatestRbeBuild({ signedUploadUrl: 'https://bucket.t3.storage.dev/put' });
    await expect(failed).rejects.toThrow(/may no longer exist, or its limbuild predates RBE upload support/);
    await expect(failed).rejects.not.toBeInstanceOf(RbeUnsupportedError);
  });

  test('retries transient gateway errors like its sibling RBE calls', async () => {
    // The proxy path can blip right after instance start; a single 502 must
    // not fail an upload of a build that succeeded. Fake timers skip the real
    // retry backoff.
    jest.useFakeTimers();
    try {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
        .mockResolvedValueOnce(new Response(uploadOk, { status: 200 }));
      nodeProxyTransport.fetchLongRequest = fetchMock;
      const { xcode } = await uploadClient();
      const upload = xcode.uploadLatestRbeBuild({ signedUploadUrl: 'https://bucket.t3.storage.dev/put' });
      await jest.advanceTimersByTimeAsync(2000);
      await expect(upload).resolves.toMatchObject({ appName: 'MyApp.app' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('an empty assetName is rejected client-side before any request', async () => {
    const fetchMock = jest.fn();
    nodeProxyTransport.fetchLongRequest = fetchMock;
    const { xcode, getOrCreate } = await uploadClient();
    await expect(xcode.uploadLatestRbeBuild({ assetName: '' })).rejects.toThrow(
      /assetName must not be empty/,
    );
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('retries the transient no-build-recorded window, then succeeds', async () => {
    // Build-end recording is asynchronous on the daemon, so the first call
    // right after bazel exits can race it; the client must ride that out.
    // Fake timers skip the real retry backoff.
    jest.useFakeTimers();
    try {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'no successful RBE app build to upload' }), {
            status: 400,
          }),
        )
        .mockResolvedValueOnce(new Response(uploadOk, { status: 200 }));
      nodeProxyTransport.fetchLongRequest = fetchMock;
      const { xcode } = await uploadClient();
      const upload = xcode.uploadLatestRbeBuild({ signedUploadUrl: 'https://bucket.t3.storage.dev/put' });
      await jest.advanceTimersByTimeAsync(2000);
      await expect(upload).resolves.toMatchObject({ appName: 'MyApp.app' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a non-no-build 400 propagates immediately without retry', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ message: 'upload URL origin "http://x" is not allowed' }), {
          status: 400,
        }),
    );
    nodeProxyTransport.fetchLongRequest = fetchMock;
    const { xcode } = await uploadClient();
    await expect(
      xcode.uploadLatestRbeBuild({ signedUploadUrl: 'https://bucket.t3.storage.dev/put' }),
    ).rejects.toThrow(/not allowed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
