import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomBytes } from 'crypto';

import Limrun from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

afterEach(() => {
  nodeProxyTransport.fetch = originalFetch;
  jest.restoreAllMocks();
});

// Larger than one 256 KB stream chunk so the streamed path pulls several times.
const fileBytes = randomBytes(600 * 1024 + 123);

let filePath: string;
beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limrun-assets-'));
  filePath = path.join(dir, 'app.zip');
  await fs.writeFile(filePath, fileBytes);
});

function clientWithAsset(md5?: string) {
  const client = new Limrun({ apiKey: 'key' });
  jest.spyOn(client.assets, 'getOrCreate').mockResolvedValue({
    id: 'asset_1',
    name: 'app.zip',
    kind: 'App',
    signedUploadUrl: 'https://asset-storage.example.test/put?sig=abc',
    signedDownloadUrl: 'https://asset-storage.example.test/get?sig=def',
    ...(md5 && { md5 }),
  } as never);
  return client;
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value!);
  }
  return Buffer.concat(chunks);
}

describe('assets.getOrUpload signed-URL PUT', () => {
  // Regression: a manual Content-Length next to a buffer body makes fetch send
  // both its own computed value and ours ("n, n"), which strict undici
  // dispatchers (in use whenever HTTP(S)_PROXY is set) reject with
  // UND_ERR_INVALID_ARG "invalid content-length header".
  test('buffered upload leaves Content-Length to fetch', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo, _init?: RequestInit) => new Response('{}'));
    nodeProxyTransport.fetch = fetchMock;
    const client = clientWithAsset();

    const asset = await client.assets.getOrUpload({ path: filePath });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe('https://asset-storage.example.test/put?sig=abc');
    expect(init?.method).toBe('PUT');
    expect(headerValue(init, 'content-length')).toBeUndefined();
    expect(headerValue(init, 'content-type')).toBe('application/octet-stream');
    expect((init as { duplex?: string }).duplex).toBeUndefined();
    expect(Buffer.isBuffer(init?.body)).toBe(true);
    expect(Buffer.compare(init?.body as Buffer, fileBytes)).toBe(0);
    expect(asset.md5).toBe(createHash('md5').update(fileBytes).digest('hex'));
  });

  test('streamed upload pins Content-Length, streams all bytes, and reports progress', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo, _init?: RequestInit) => new Response('{}'));
    nodeProxyTransport.fetch = fetchMock;
    const client = clientWithAsset();
    const progress: Array<[number, number]> = [];

    await client.assets.getOrUpload({
      path: filePath,
      onUploadProgress: (uploaded, total) => progress.push([uploaded, total]),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(headerValue(init, 'content-length')).toBe(fileBytes.length.toString());
    expect((init as { duplex?: string }).duplex).toBe('half');
    const sent = await readAll(init?.body as ReadableStream<Uint8Array>);
    expect(Buffer.compare(sent, fileBytes)).toBe(0);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toEqual([fileBytes.length, fileBytes.length]);
  });

  test('matching md5 skips the upload', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo, _init?: RequestInit) => new Response('{}'));
    nodeProxyTransport.fetch = fetchMock;
    const client = clientWithAsset(createHash('md5').update(fileBytes).digest('hex'));

    const asset = await client.assets.getOrUpload({ path: filePath });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(asset.id).toBe('asset_1');
  });
});
