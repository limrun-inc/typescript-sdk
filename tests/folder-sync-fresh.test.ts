import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { syncFolder } from '@limrun/api/folder-sync';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import Limrun, { FreshUnsupportedError } from '@limrun/api';

const originalFetch = nodeProxyTransport.fetch;

type SyncBody = { fresh?: boolean; payloads: { kind: string; path: string }[] };

async function readSyncMeta(init: RequestInit): Promise<SyncBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of init.body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  let body = Buffer.concat(chunks);
  const encoding = (init.headers as Record<string, string>)['Content-Encoding'];
  if (encoding === 'gzip') {
    body = zlib.gunzipSync(body);
  } else if (encoding === 'zstd') {
    body = (zlib as any).zstdDecompressSync(body);
  }
  const metaLen = body.readUInt32BE(0);
  return JSON.parse(body.subarray(4, 4 + metaLen).toString('utf-8')) as SyncBody;
}

describe('fresh sync', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('fresh wipes local caches and sends everything full with meta.fresh', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-fresh-'));
    const basisCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-fresh-basis-'));
    fs.writeFileSync(path.join(root, 'a.swift'), 'let a = 1\n');
    const bodies: Array<Promise<SyncBody>> = [];
    nodeProxyTransport.fetch = jest.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(readSyncMeta(init!));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof nodeProxyTransport.fetch;

    const opts = {
      apiUrl: 'https://xcode.example.test',
      token: 't',
      udid: 'test',
      basisCacheDir,
      install: false,
      launchMode: 'ForegroundIfRunning' as const,
      watch: false,
      maxPatchBytes: 4 * 1024 * 1024,
      log: () => {},
      ignoreFn: () => false,
    };

    // Warm sync: basis populated, second plain sync sends nothing.
    await syncFolder(root, opts);
    await syncFolder(root, opts);
    expect((await bodies[1]!).payloads.length).toBe(0);
    expect((await bodies[1]!).fresh).toBeUndefined();

    // Fresh sync: everything full despite the warm basis; meta.fresh set.
    await syncFolder(root, { ...opts, fresh: true });
    const freshBody = await bodies[2]!;
    expect(freshBody.fresh).toBe(true);
    expect(freshBody.payloads.map((p) => p.kind)).toEqual(['full']);
  });

  test('rejects with FreshUnsupportedError before any /sync on an old daemon', async () => {
    const calls: string[] = [];
    nodeProxyTransport.fetch = jest.fn(async (input: unknown) => {
      calls.push(String(input));
      if (String(input).endsWith('/info')) {
        return new Response(JSON.stringify({ homeDir: '.limbuild-sandbox/home' }), { status: 200 });
      }
      throw new Error(`unexpected request: ${input}`);
    }) as typeof nodeProxyTransport.fetch;

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-fresh-gate-'));

    await expect(xcode.sync(root, { watch: false, fresh: true })).rejects.toThrow(FreshUnsupportedError);
    expect(calls.some((c) => c.endsWith('/sync'))).toBe(false);
  });
});
