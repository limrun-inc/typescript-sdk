jest.mock('eventsource-client', () => ({
  createEventSource: jest.fn(),
}));

import Limrun, { exec, getExec, type ArtifactManifest, type XcodeArtifactOutput } from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';
import { createEventSource, type EventSourceOptions } from 'eventsource-client';

const originalFetch = nodeProxyTransport.fetch;

beforeEach(() => {
  jest.mocked(createEventSource).mockImplementation((optionsOrUrl) => {
    const { onMessage } = optionsOrUrl as EventSourceOptions;
    setTimeout(() => onMessage?.({ event: 'exitCode', data: '0' }), 0);
    return { close: jest.fn() } as never;
  });
});

afterEach(() => {
  nodeProxyTransport.fetch = originalFetch;
  jest.clearAllMocks();
});

test('low-level exec serializes repeated outputs and preserves equals signs in signed URLs', async () => {
  const bodies: unknown[] = [];
  mockExecTransport(bodies);

  await exec(
    {
      command: 'run',
      commandLine: 'make reports',
      outputs: [
        {
          name: 'coverage',
          source: 'workspace',
          path: 'reports/coverage.json',
          signedUploadUrl: 'https://storage.example/coverage?token=abc==&part=1',
        },
        {
          name: 'logs',
          path: 'logs',
          signedUploadUrl: 'https://storage.example/logs?signature=a=b=c',
        },
      ],
    },
    { apiUrl: 'https://xcode.example.test', token: 'token' },
  );

  expect(bodies).toEqual([
    {
      command: 'run',
      commandLine: 'make reports',
      outputs: [
        {
          name: 'coverage',
          source: 'workspace',
          path: 'reports/coverage.json',
          signedUploadUrl: 'https://storage.example/coverage?token=abc==&part=1',
        },
        {
          name: 'logs',
          path: 'logs',
          signedUploadUrl: 'https://storage.example/logs?signature=a=b=c',
        },
      ],
    },
  ]);
});

test('run helper uploads workspace outputs and returns the terminal SSE manifest', async () => {
  const bodies: unknown[] = [];
  mockExecTransport(bodies);
  emitTerminalMetadata([
    manifest({ name: 'report', path: 'reports/output.json', kind: 'file', transferFormat: 'raw' }),
  ]);
  const xcode = await createXcodeClient();

  const result = await xcode.run('make report', {
    outputs: [
      {
        name: 'report',
        path: 'reports/output.json',
        signedUploadUrl: 'https://storage.example/report?signature=x=y',
      },
    ],
  });

  expect(bodies[0]).toMatchObject({
    command: 'run',
    outputs: [
      {
        name: 'report',
        source: 'workspace',
        path: 'reports/output.json',
        signedUploadUrl: 'https://storage.example/report?signature=x=y',
      },
    ],
  });
  expect(result.metadata?.status).toBe('SUCCEEDED');
  expect(result.artifacts).toEqual([
    manifest({ name: 'report', path: 'reports/output.json', kind: 'file', transferFormat: 'raw' }),
  ]);
});

test('build-for-testing helper presigns managed outputs and decorates their manifests', async () => {
  const bodies: unknown[] = [];
  mockExecTransport(bodies);
  emitTerminalMetadata([
    manifest({
      name: 'products',
      source: 'testProducts',
      path: '.limbuild-sandbox/derived-data/Build/Products',
    }),
    manifest({
      name: 'xcresult',
      source: 'resultBundle',
      path: '.limbuild-sandbox/result-bundles/build-1/build.xcresult',
    }),
  ]);
  const client = new Limrun({ apiKey: 'key' });
  const getOrCreate = jest
    .spyOn(client.assets, 'getOrCreate')
    .mockResolvedValueOnce({
      id: 'asset-products',
      signedUploadUrl: 'https://storage.example/ci/products/put?signature=a=b',
      signedDownloadUrl: 'https://storage.example/ci/products/get?signature=c=d',
    } as never)
    .mockResolvedValueOnce({
      id: 'asset-xcresult',
      signedUploadUrl: 'https://storage.example/ci/xcresult/put?signature=a=b',
      signedDownloadUrl: 'https://storage.example/ci/xcresult/get?signature=c=d',
    } as never);
  const xcode = await client.xcodeInstances.createClient({
    apiUrl: 'https://xcode.example.test',
    token: 'token',
  });

  const result = await xcode.xcodebuild(
    { action: 'build-for-testing', sdk: 'iphonesimulator' },
    {
      outputs: [
        { name: 'products', source: 'testProducts', assetName: 'ci/products', ttl: '24h' },
        { name: 'xcresult', source: 'resultBundle', assetName: 'ci/xcresult' },
      ],
    },
  );

  expect(getOrCreate).toHaveBeenNthCalledWith(1, { name: 'ci/products', ttl: '24h' });
  expect(getOrCreate).toHaveBeenNthCalledWith(2, { name: 'ci/xcresult', ttl: '336h' });
  expect(bodies[0]).toMatchObject({
    command: 'xcodebuild',
    xcodebuild: { action: 'build-for-testing', sdk: 'iphonesimulator' },
    outputs: [
      {
        name: 'products',
        source: 'testProducts',
        signedUploadUrl: 'https://storage.example/ci/products/put?signature=a=b',
      },
      {
        name: 'xcresult',
        source: 'resultBundle',
        signedUploadUrl: 'https://storage.example/ci/xcresult/put?signature=a=b',
      },
    ],
  });
  expect(result.artifacts?.map(({ name, signedDownloadUrl }) => ({ name, signedDownloadUrl }))).toEqual([
    {
      name: 'products',
      signedDownloadUrl: 'https://storage.example/ci/products/get?signature=c=d',
    },
    {
      name: 'xcresult',
      signedDownloadUrl: 'https://storage.example/ci/xcresult/get?signature=c=d',
    },
  ]);
});

test('helpers reject invalid source and path combinations before POST /exec', async () => {
  const bodies: unknown[] = [];
  mockExecTransport(bodies);
  const xcode = await createXcodeClient();

  expect(() =>
    xcode.xcodebuild(undefined, {
      outputs: [{ name: 'products', source: 'testProducts', signedUploadUrl: 'https://storage.example/put' }],
    }),
  ).toThrow("requires xcodebuild action: 'build-for-testing'");
  expect(() =>
    xcode.run('true', {
      outputs: [
        {
          name: 'bad',
          path: '../outside',
          signedUploadUrl: 'https://storage.example/put',
        },
      ],
    }),
  ).toThrow('relative workspace path');

  const invalidManagedPath = {
    name: 'result',
    source: 'resultBundle',
    path: 'build.xcresult',
    signedUploadUrl: 'https://storage.example/put',
  } as unknown as XcodeArtifactOutput;
  expect(() => xcode.xcodebuild(undefined, { outputs: [invalidManagedPath] })).toThrow(
    'path must be omitted',
  );
  expect(bodies).toHaveLength(0);
});

test('GET execution metadata is available through low-level and Xcode clients', async () => {
  const metadata = {
    id: 'build/with space',
    status: 'SUCCEEDED' as const,
    exitCode: 0,
    artifacts: [manifest({ name: 'result', source: 'resultBundle', path: 'result.xcresult' })],
  };
  const calls: string[] = [];
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)} ${new Headers(init?.headers).get('Authorization')}`);
    return jsonResponse(metadata);
  });

  await expect(
    getExec('build/with space', { apiUrl: 'https://xcode.example.test', token: 'token' }),
  ).resolves.toEqual(metadata);
  const xcode = await createXcodeClient();
  await expect(xcode.getExec('build/with space')).resolves.toEqual(metadata);
  expect(calls).toEqual([
    'GET https://xcode.example.test/exec/build%2Fwith%20space Bearer token',
    'GET https://xcode.example.test/exec/build%2Fwith%20space Bearer token',
  ]);
});

test('awaited executions recover terminal manifests with GET when the SSE meta frame is missing', async () => {
  const recoveredArtifact = manifest({
    name: 'report',
    path: 'reports/output.json',
    kind: 'file',
    transferFormat: 'raw',
  });
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://xcode.example.test/exec') {
      return jsonResponse({ execId: 'run-1' });
    }
    if (url === 'https://xcode.example.test/exec/run-1' && init?.method === 'GET') {
      return jsonResponse({
        id: 'run-1',
        status: 'SUCCEEDED',
        exitCode: 0,
        artifacts: [recoveredArtifact],
      });
    }
    throw new Error(`unexpected request: ${input}`);
  });

  const result = await exec(
    {
      command: 'run',
      commandLine: 'make report',
      outputs: [
        {
          name: 'report',
          path: 'reports/output.json',
          signedUploadUrl: 'https://storage.example/report',
        },
      ],
    },
    { apiUrl: 'https://xcode.example.test', token: 'token' },
  );

  expect(result.artifacts).toEqual([recoveredArtifact]);
  expect(result.metadata?.id).toBe('run-1');
});

function mockExecTransport(bodies: unknown[]): void {
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    if (String(input) === 'https://xcode.example.test/exec') {
      bodies.push(JSON.parse(init?.body as string));
      return jsonResponse({ execId: 'build-1' });
    }
    throw new Error(`unexpected request: ${input}`);
  });
}

function emitTerminalMetadata(artifacts: ArtifactManifest[]): void {
  jest.mocked(createEventSource).mockImplementationOnce((optionsOrUrl) => {
    const { onMessage } = optionsOrUrl as EventSourceOptions;
    setTimeout(() => {
      onMessage?.({
        event: 'meta',
        data: JSON.stringify({ id: 'build-1', status: 'SUCCEEDED', exitCode: 0, artifacts }),
      });
      onMessage?.({ event: 'exitCode', data: '0' });
    }, 0);
    return { close: jest.fn() } as never;
  });
}

function manifest(
  overrides: Partial<ArtifactManifest> & Pick<ArtifactManifest, 'name' | 'path'>,
): ArtifactManifest {
  return {
    name: overrides.name,
    source: overrides.source ?? 'workspace',
    path: overrides.path,
    kind: overrides.kind ?? 'directory',
    transferFormat: overrides.transferFormat ?? 'tarGzip',
    byteSize: overrides.byteSize ?? 42,
    uploaded: overrides.uploaded ?? true,
    sha256: overrides.sha256 ?? 'abc123',
    contentType: overrides.contentType ?? 'application/gzip',
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

async function createXcodeClient() {
  const client = new Limrun({ apiKey: 'key' });
  return client.xcodeInstances.createClient({
    apiUrl: 'https://xcode.example.test',
    token: 'token',
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
