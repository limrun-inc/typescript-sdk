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

async function startStubServer(response: object = { ok: true }): Promise<StubServer> {
  const requests: WireMeta[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = decodeBody(Buffer.concat(chunks), req.headers['content-encoding'] as string);
      const metaLen = body.readUInt32BE(0);
      requests.push(JSON.parse(body.subarray(4, 4 + metaLen).toString('utf-8')) as WireMeta);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
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

  test('a symlinked dir replaced by a real dir does not corrupt the target basis', async () => {
    // Sync 1: 'dir' is a symlink to the 'shared' directory.
    fs.symlinkSync('shared', path.join(tree, 'dir'));
    let server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, syncOpts(server, cache));
    } finally {
      await server.close();
    }
    expect(fs.lstatSync(path.join(cache, 'dir')).isSymbolicLink()).toBe(true);

    // Sync 2: replace 'dir' with a real directory holding its own file. The
    // stale cache symlink at cache/dir must be pruned so dir/a.txt is not
    // written through it into cache/shared, corrupting shared/real.swift's basis.
    fs.rmSync(path.join(tree, 'dir'));
    fs.mkdirSync(path.join(tree, 'dir'));
    fs.writeFileSync(path.join(tree, 'dir', 'a.txt'), 'dir-a-content\n');
    server = await startStubServer({ ok: true });
    try {
      await syncFolder(tree, syncOpts(server, cache));
    } finally {
      await server.close();
    }
    // shared/real.swift basis is intact (not overwritten via the stale link).
    expect(fs.readFileSync(path.join(cache, 'shared', 'real.swift'), 'utf-8')).toBe('let x = 1\n');
    // cache/dir is now a real directory with the right file.
    expect(fs.lstatSync(path.join(cache, 'dir')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(cache, 'dir', 'a.txt'), 'utf-8')).toBe('dir-a-content\n');
  });
});
