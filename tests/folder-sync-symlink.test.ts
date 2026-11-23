import { Limrun } from '@limrun/api';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { syncFolder, type FolderSyncOptions } from '@limrun/api/folder-sync';

type WireFile = { path: string; size: number; sha256: string; mode?: number; link?: string };
type WireMeta = {
  files: WireFile[];
  payloads: { kind: 'delta' | 'full'; path: string; length: number }[];
};

type StubServer = {
  url: string;
  requests: WireMeta[];
  close: () => Promise<void>;
};

function decodeBody(raw: Buffer, encoding: string | undefined): Buffer {
  if (encoding === 'gzip') return zlib.gunzipSync(raw);
  if (encoding === 'zstd') {
    const decompress = (zlib as any).zstdDecompressSync as ((b: Buffer) => Buffer) | undefined;
    if (!decompress) throw new Error('zstd request body but no zstd support in this Node');
    return decompress(raw);
  }
  return raw;
}

async function startStubServer(
  response: object | object[] = { ok: true },
  onRequest?: (request: number, meta: WireMeta, payload: Buffer) => void,
): Promise<StubServer> {
  const requests: WireMeta[] = [];
  // An array means one response per request, in order (the last one repeats).
  const responses = Array.isArray(response) ? response : [response];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = decodeBody(Buffer.concat(chunks), req.headers['content-encoding'] as string);
      const metaLen = body.readUInt32BE(0);
      requests.push(JSON.parse(body.subarray(4, 4 + metaLen).toString('utf-8')) as WireMeta);
      onRequest?.(requests.length, requests[requests.length - 1]!, body.subarray(4 + metaLen));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(responses[Math.min(requests.length - 1, responses.length - 1)]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function syncOpts(server: StubServer, basisCacheDir: string): FolderSyncOptions {
  return {
    apiUrl: server.url,
    token: 'test-token',
    udid: 'test',
    basisCacheDir,
    install: false,
    launchMode: 'ForegroundIfRunning',
    watch: false,
    log: () => {},
    ignoreFn: () => false,
    syncSymlinks: true,
  };
}

describe('folder-sync symlinks', () => {
  let tmpDir: string;
  let tree: string;
  let cache: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sync-symlink-test-'));
    tree = path.join(tmpDir, 'proj');
    cache = path.join(tmpDir, 'basis-cache');
    fs.mkdirSync(path.join(tree, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'ios'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'shared', 'real.swift'), 'let x = 1\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Gradle sync sends additional files outside the source tree', async () => {
    const extra = path.join(tmpDir, 'client-config');
    fs.writeFileSync(extra, 'registry=https://registry.example.test\n');
    const server = await startStubServer({ ok: true });
    try {
      const lim = new Limrun({ apiKey: 'test-key' });
      const gradle = await lim.gradleInstances.createClient({
        apiUrl: server.url,
        token: 'test-token',
        logLevel: 'none',
      });
      await gradle.sync(tree, {
        basisCacheDir: cache,
        additionalFiles: [{ localPath: extra, remotePath: '.npmrc' }],
      });
    } finally {
      await server.close();
    }
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.files.map((file) => file.path)).toContain('.npmrc');
    expect(server.requests[0]!.payloads.map((payload) => payload.path)).toContain('.npmrc');
  });

  test('emits link entries with the literal target and no payload', async () => {
    fs.symlinkSync('../shared/real.swift', path.join(tree, 'ios', 'link.swift'));
    const server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, syncOpts(server, cache));
    } finally {
      await server.close();
    }

    expect(server.requests).toHaveLength(1);
    const meta = server.requests[0]!;
    const link = meta.files.find((f) => f.path === 'ios/link.swift');
    expect(link).toBeDefined();
    expect(link!.link).toBe('../shared/real.swift');
    expect(link!.mode).toBeUndefined();
    expect(link!.size).toBe(Buffer.byteLength('../shared/real.swift'));
    expect(meta.payloads.map((p) => p.path)).not.toContain('ios/link.swift');
    // The regular file still travels as a normal full payload.
    expect(meta.payloads.map((p) => p.path)).toContain('shared/real.swift');
  });

  test('symlinks are dropped when syncSymlinks is off (app-install path)', async () => {
    fs.symlinkSync('../shared/real.swift', path.join(tree, 'ios', 'link.swift'));
    const server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, { ...syncOpts(server, cache), syncSymlinks: false });
    } finally {
      await server.close();
    }
    const meta = server.requests[0]!;
    expect(meta.files.map((f) => f.path)).not.toContain('ios/link.swift');
  });

  test('rejects a relative escaping target at sync time', async () => {
    fs.symlinkSync('../../outside.swift', path.join(tree, 'ios', 'link.swift'));
    const server = await startStubServer({ ok: true });
    try {
      await expect(syncFolder(tree, syncOpts(server, cache))).rejects.toThrow(/points outside the sync root/);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test('warns and skips an absolute-target symlink instead of failing the sync', async () => {
    // Absolute targets can never resolve remotely; pre-symlink clients
    // silently skipped all links, so a decorative /usr/... link must not
    // turn a working sync into a hard failure.
    fs.symlinkSync('/etc/hosts', path.join(tree, 'ios', 'abs-link'));
    const warnings: string[] = [];
    const server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, {
        ...syncOpts(server, cache),
        log: (level, msg) => {
          if (level === 'warn') warnings.push(msg);
        },
      });
    } finally {
      await server.close();
    }
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.files.map((f) => f.path)).not.toContain('ios/abs-link');
    expect(warnings.join('\n')).toMatch(/skipping symlink ios\/abs-link/);
  });

  test('rejects a backslash-containing target at sync time (daemon parity)', async () => {
    fs.symlinkSync('weird\\name.swift', path.join(tree, 'ios', 'bs-link'));
    const server = await startStubServer({ ok: true });
    try {
      await expect(syncFolder(tree, syncOpts(server, cache))).rejects.toThrow(/backslash/);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test('a symlinked dir matching a dir-exclude is skipped, not validated/thrown', async () => {
    // Pods -> /opt/shared-pods (absolute, out-of-root). An excluded symlink
    // must be dropped by the ignore probe before validateSymlinkTarget throws.
    fs.symlinkSync('/opt/shared-pods', path.join(tree, 'Pods'));
    const server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, {
        ...syncOpts(server, cache),
        // Directory-form exclude, as the real Pods/ default would produce.
        ignoreFn: (p) => p === 'Pods/',
      });
    } finally {
      await server.close();
    }
    // Sync succeeded (no throw) and Pods was not uploaded.
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.files.map((f) => f.path)).not.toContain('Pods');
  });

  test('old daemon asking full for a symlink fails loud without uploading', async () => {
    fs.symlinkSync('../shared/real.swift', path.join(tree, 'ios', 'link.swift'));
    const server = await startStubServer({ ok: false, needFull: ['ios/link.swift'] });
    try {
      await expect(syncFolder(tree, syncOpts(server, cache))).rejects.toThrow(/does not support symlinks/);
      // No retry request: the target's content must never be uploaded as a file.
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  test('a source edit during upload waits for the next sync', async () => {
    const rel = 'shared/real.swift';
    const source = path.join(tree, rel);
    const old = fs.readFileSync(source, 'utf8');
    const updated = old + '// edited during upload';
    const payloads: string[] = [];
    const server = await startStubServer(
      [{ ok: false, needFull: [rel] }, { ok: true }],
      (request, meta, payload) => {
        payloads.push(payload.toString());
        if (request === 1) fs.writeFileSync(source, updated);
      },
    );
    try {
      await syncFolder(tree, syncOpts(server, cache));
      expect(payloads).toEqual([old, old]);
      expect(fs.readFileSync(path.join(cache, rel), 'utf8')).toBe(old);
      await syncFolder(tree, syncOpts(server, cache));
      expect(payloads[2]).toBe(updated);
      expect(fs.readFileSync(path.join(cache, rel), 'utf8')).toBe(updated);
    } finally {
      await server.close();
    }
  });

  test('needFull retry counts resent bytes once', async () => {
    fs.writeFileSync(path.join(tree, 'ios', 'data.swift'), 'x'.repeat(1000));
    const server = await startStubServer([{ ok: false, needFull: ['ios/data.swift'] }, { ok: true }]);
    try {
      const result = await syncFolder(tree, syncOpts(server, cache));
      expect(server.requests).toHaveLength(2);
      // Reported bytes must equal the payload bytes that went over the wire.
      const wireBytes = server.requests.flatMap((r) => r.payloads).reduce((sum, p) => sum + p.length, 0);
      expect(result.bytesSent).toBe(wireBytes);
    } finally {
      await server.close();
    }
  });

  test('type flips: file->symlink sends a link entry; symlink->file sends a FULL payload', async () => {
    const p = path.join(tree, 'ios', 'thing.swift');

    // Sync 1: regular file, populates the basis cache.
    fs.writeFileSync(p, 'regular v1\n');
    let server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, syncOpts(server, cache));
    } finally {
      await server.close();
    }

    // Sync 2: replaced by a symlink -> link entry, no payload for the path.
    fs.rmSync(p);
    fs.symlinkSync('../shared/real.swift', p);
    server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, syncOpts(server, cache));
    } finally {
      await server.close();
    }
    let meta = server.requests[0]!;
    expect(meta.files.find((f) => f.path === 'ios/thing.swift')!.link).toBe('../shared/real.swift');
    expect(meta.payloads.map((x) => x.path)).not.toContain('ios/thing.swift');

    // Sync 3: back to a regular file. The basis cache holds a symlink for
    // this path, so the client must send a FULL payload (never a delta
    // against a link) and must not have written v2 content through the
    // stale cache link into the cached target.
    fs.rmSync(p);
    fs.writeFileSync(p, 'regular v2\n');
    server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, syncOpts(server, cache));
    } finally {
      await server.close();
    }
    meta = server.requests[0]!;
    const payload = meta.payloads.find((x) => x.path === 'ios/thing.swift');
    expect(payload).toBeDefined();
    expect(payload!.kind).toBe('full');
    const cachedTarget = fs.readFileSync(path.join(cache, 'shared', 'real.swift'), 'utf-8');
    expect(cachedTarget).toBe('let x = 1\n');
    // And the cache now holds a regular file for the flipped path.
    expect(fs.lstatSync(path.join(cache, 'ios', 'thing.swift')).isSymbolicLink()).toBe(false);
  });

  test('unchanged symlink stays a symlink in the basis cache across syncs', async () => {
    fs.symlinkSync('../shared/real.swift', path.join(tree, 'ios', 'link.swift'));
    for (let i = 0; i < 2; i++) {
      const server = await startStubServer({ ok: true });
      try {
        await syncFolder(tree, syncOpts(server, cache));
      } finally {
        await server.close();
      }
    }
    const cached = path.join(cache, 'ios', 'link.swift');
    expect(fs.lstatSync(cached).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(cached)).toBe('../shared/real.swift');
  });

  test.each([true, false])(
    'syncs an identical directory copy independently of its former link target (syncSymlinks=%s)',
    async (syncSymlinks) => {
      const shared = path.join(tree, 'shared');
      const dir = path.join(tree, 'dir');
      fs.symlinkSync('shared', dir);
      const server = await startStubServer([
        { ok: true },
        { ok: false, error: 'sync rejected' },
        { ok: true },
      ]);
      try {
        const opts = syncOpts(server, cache);
        await syncFolder(tree, opts);
        fs.unlinkSync(dir);
        fs.cpSync(shared, dir, { recursive: true });
        const next = { ...opts, syncSymlinks };

        await expect(syncFolder(tree, next)).rejects.toThrow('sync rejected');
        expect(fs.readlinkSync(path.join(cache, 'dir'))).toBe('shared');

        await syncFolder(tree, next);
        expect(server.requests[2]!.payloads).toEqual([
          expect.objectContaining({ path: 'dir/real.swift', kind: 'full' }),
        ]);
        expect(fs.lstatSync(path.join(cache, 'dir')).isDirectory()).toBe(true);
        fs.writeFileSync(path.join(shared, 'real.swift'), 'updated target');
        await syncFolder(tree, next);
        expect(server.requests[3]!.payloads.map((p) => p.path)).toEqual(['shared/real.swift']);
        expect(fs.readFileSync(path.join(cache, 'dir', 'real.swift'), 'utf8')).toBe('let x = 1\n');
      } finally {
        await server.close();
      }
    },
  );

  test('a symlinked dir replaced by a real dir does not corrupt the target basis', async () => {
    // Sync 1: 'dir' is a symlink to the 'shared' directory.
    const original = Buffer.alloc(128 * 1024, 'a');
    fs.writeFileSync(path.join(tree, 'shared', 'bundle.bin'), original);
    fs.symlinkSync('shared', path.join(tree, 'dir'));
    let server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, syncOpts(server, cache));
    } finally {
      await server.close();
    }
    expect(fs.lstatSync(path.join(cache, 'dir')).isSymbolicLink()).toBe(true);

    // The old link target would make a small delta, but it is not a basis for dir/bundle.bin.
    fs.rmSync(path.join(tree, 'dir'));
    fs.mkdirSync(path.join(tree, 'dir'));
    const updated = Buffer.from(original);
    updated[0] = 0;
    fs.writeFileSync(path.join(tree, 'dir', 'bundle.bin'), updated);
    server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, syncOpts(server, cache));
    } finally {
      await server.close();
    }
    expect(server.requests[0]!.payloads).toEqual([
      expect.objectContaining({ path: 'dir/bundle.bin', kind: 'full' }),
    ]);
    expect(fs.readFileSync(path.join(cache, 'shared', 'bundle.bin')).equals(original)).toBe(true);
    expect(fs.lstatSync(path.join(cache, 'dir')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(cache, 'dir', 'bundle.bin')).equals(updated)).toBe(true);
  });
});
