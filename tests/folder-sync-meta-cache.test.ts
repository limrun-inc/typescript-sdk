import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { syncFolder } from '@limrun/api/folder-sync';
import { loadMetaCache, saveMetaCache, emptyMetaCache } from '@limrun/api/folder-sync-meta-cache';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';

const originalFetch = nodeProxyTransport.fetch;

type SyncBody = { files: { path: string }[]; payloads: { kind: string; path: string }[] };

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

function mockSyncTransport(): Array<Promise<SyncBody>> {
  const bodies: Array<Promise<SyncBody>> = [];
  nodeProxyTransport.fetch = jest.fn(async (_input: unknown, init?: RequestInit) => {
    bodies.push(readSyncMeta(init!));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof nodeProxyTransport.fetch;
  return bodies;
}

function syncOpts(basisCacheDir: string) {
  return {
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
}

describe('sync metadata cache', () => {
  let root: string;
  let basisCacheDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-meta-root-'));
    basisCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-meta-basis-'));
    fs.writeFileSync(path.join(root, 'a.swift'), 'let a = 1\n');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.swift'), 'let b = 2\n');
  });

  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('missing or corrupt cache files fall back to empty', async () => {
    expect(await loadMetaCache(basisCacheDir)).toEqual(emptyMetaCache());
    fs.writeFileSync(path.join(basisCacheDir, '.limsync-meta.json'), '{not json');
    expect(await loadMetaCache(basisCacheDir)).toEqual(emptyMetaCache());
    fs.writeFileSync(path.join(basisCacheDir, '.limsync-meta.json'), JSON.stringify({ version: 99 }));
    expect(await loadMetaCache(basisCacheDir)).toEqual(emptyMetaCache());
  });

  test('save/load round-trips', async () => {
    const cache = emptyMetaCache();
    cache.files['a.swift'] = { mtimeMs: 123.456, size: 10, sha256: 'ab' };
    cache.basis['a.swift'] = { mtimeMs: 124.5, size: 10, sha256: 'ab' };
    await saveMetaCache(basisCacheDir, cache);
    expect(await loadMetaCache(basisCacheDir)).toEqual(cache);
  });

  test('second sync of an unchanged tree hashes nothing and sends no payloads', async () => {
    const bodies = mockSyncTransport();

    await syncFolder(root, syncOpts(basisCacheDir));
    expect((await bodies[0]!).payloads.length).toBe(2);

    // sha256FileHex is the only createReadStream user in the sync path, so
    // zero calls proves both the walk and the basis compare reused the cache.
    const readStreamSpy = jest.spyOn(fs, 'createReadStream');
    await syncFolder(root, syncOpts(basisCacheDir));
    expect(readStreamSpy).not.toHaveBeenCalled();
    const second = await bodies[1]!;
    expect(second.payloads.length).toBe(0);
    expect(second.files.length).toBe(2);
  });

  test('a touched file re-hashes; changed content produces a payload', async () => {
    const bodies = mockSyncTransport();
    await syncFolder(root, syncOpts(basisCacheDir));

    // Touch: same content, new mtime -> re-hash but no payload.
    const aPath = path.join(root, 'a.swift');
    fs.utimesSync(aPath, new Date(), new Date(Date.now() + 5000));
    const readStreamSpy = jest.spyOn(fs, 'createReadStream');
    await syncFolder(root, syncOpts(basisCacheDir));
    expect(readStreamSpy.mock.calls.some(([p]) => String(p) === aPath)).toBe(true);
    expect((await bodies[1]!).payloads.length).toBe(0);

    // Content change -> payload for exactly that file.
    fs.writeFileSync(aPath, 'let a = 42\n');
    await syncFolder(root, syncOpts(basisCacheDir));
    const third = await bodies[2]!;
    expect(third.payloads.map((p) => p.path)).toEqual(['a.swift']);
  });
});
