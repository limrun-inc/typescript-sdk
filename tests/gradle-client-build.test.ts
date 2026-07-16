import { Limrun } from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const API_URL = 'https://node.limrun.net/v1/gradle_test123/api';
const TOKEN = 'test-token';

const originalFetch = nodeProxyTransport.fetch;

afterEach(() => {
  nodeProxyTransport.fetch = originalFetch;
  jest.restoreAllMocks();
});

/** A one-shot SSE response streaming the given frames, then closing. */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('retry: 1\n\n'));
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function gradleClient() {
  const client = new Limrun({ apiKey: 'key' });
  return client.gradleInstances.createClient({ apiUrl: API_URL, token: TOKEN });
}

// The wire contract the daemon's conformance tests pin from the server side:
// POST /exec carries the gradlebuild command envelope, the SSE stream's
// terminal exitCode event resolves the build, and stdout lines stream through.
test('gradlebuild posts the exec envelope and resolves on exitCode 0', async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/exec')) {
      return new Response(JSON.stringify({ execId: 'build-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/exec/build-1/events')) {
      return sseResponse([
        'event: command\ndata: ./gradlew --console=plain bundleRelease\n\n',
        'event: stdout\ndata: BUILD SUCCESSFUL\n\n',
        'event: exitCode\ndata: 0\n\n',
      ]);
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const gradle = await gradleClient();
  const proc = gradle.gradlebuild({
    tasks: ['bundleRelease'],
    projectPath: 'android',
    upload: { signedUploadUrl: 'https://storage.example.com/presigned' },
  });
  const stdout: string[] = [];
  proc.stdout.on('data', (line: string) => stdout.push(line));
  const result = await proc;

  expect(result.exitCode).toBe(0);
  expect(result.status).toBe('SUCCEEDED');
  expect(stdout).toContain('BUILD SUCCESSFUL');

  const execReq = requests.find((r) => r.url.endsWith('/exec'));
  expect(execReq?.body).toEqual({
    command: 'gradlebuild',
    tasks: ['bundleRelease'],
    projectPath: 'android',
    signedUploadUrl: 'https://storage.example.com/presigned',
  });
});

// Presence is pinned here; absence is pinned by the exact-match envelope
// assertion in the test above (the server treats any reactNative value as
// opting into the Expo pipeline, so the key must stay off plain builds).
test('gradlebuild threads reactNative to the wire when set', async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/exec')) {
      return new Response(JSON.stringify({ execId: 'build-rn' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/exec/build-rn/events')) {
      return sseResponse(['event: exitCode\ndata: 0\n\n']);
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const gradle = await gradleClient();
  const result = await gradle.gradlebuild({
    reactNative: { expoAppDir: 'apps/mobile', architectures: ['x86_64'] },
  });

  expect(result.exitCode).toBe(0);
  const execReq = requests.find((r) => r.url.endsWith('/exec'));
  expect(execReq?.body).toEqual({
    command: 'gradlebuild',
    reactNative: { expoAppDir: 'apps/mobile', architectures: ['x86_64'] },
  });
});

test('gradlebuild reports failure exit codes from the stream', async () => {
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/exec')) {
      return new Response(JSON.stringify({ execId: 'build-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/exec/build-2/events')) {
      return sseResponse(['event: stderr\ndata: FAILURE: Build failed\n\n', 'event: exitCode\ndata: 7\n\n']);
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const gradle = await gradleClient();
  const result = await gradle.gradlebuild();
  expect(result.exitCode).toBe(7);
  expect(result.status).toBe('FAILED');
});

test('gradlebuild --upload mints asset URLs before posting exec', async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/exec')) {
      return new Response(JSON.stringify({ execId: 'build-3' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/exec/build-3/events')) {
      return sseResponse(['event: exitCode\ndata: 0\n\n']);
    }
    throw new Error(`unexpected request: ${url}`);
  });

  const client = new Limrun({ apiKey: 'key' });
  jest.spyOn(client.assets, 'getOrCreate').mockResolvedValue({
    signedUploadUrl: 'https://storage.example.com/up',
    signedDownloadUrl: 'https://storage.example.com/down',
  } as never);
  const gradle = await client.gradleInstances.createClient({ apiUrl: API_URL, token: TOKEN });

  const result = await gradle.gradlebuild({ upload: { assetName: 'myapp.apk' } });
  expect(result.exitCode).toBe(0);
  expect(result.signedDownloadUrl).toBe('https://storage.example.com/down');

  const execReq = requests.find((r) => r.url.endsWith('/exec'));
  expect(execReq?.body).toMatchObject({
    command: 'gradlebuild',
    signedUploadUrl: 'https://storage.example.com/up',
  });
});
