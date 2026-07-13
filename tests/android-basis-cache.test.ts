import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import { bootstrapAndroidBasisCache, type AndroidSyncState } from '../src/internal/android-basis-cache';
import { type SeedSignature, weakRollingChecksum } from '../src/internal/seed-reconstruct';

const noopLog = () => {};

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function signatureFor(seed: Buffer, blockSize: number): SeedSignature {
  const blocks = [];
  for (let offset = 0; offset < seed.byteLength; offset += blockSize) {
    const block = seed.subarray(offset, Math.min(offset + blockSize, seed.byteLength));
    blocks.push({ w: weakRollingChecksum(block), s: sha256Hex(block).slice(0, 32) });
  }
  return {
    version: 1,
    blockSize,
    fileSize: seed.byteLength,
    sha256: sha256Hex(seed),
    blocks,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-basis-test-'));
}

type TestServer = { url: string; requests: string[]; close: () => Promise<void> };

async function startServer(
  state: AndroidSyncState,
  seedBodies: Record<string, Buffer> = {},
  signatures: Record<string, SeedSignature> = {},
): Promise<TestServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/sync/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state));
      return;
    }
    const signatureMatch = req.url?.match(/^\/sync\/seeds\/([0-9a-f]{64})\.sig$/);
    const signature = signatureMatch ? signatures[signatureMatch[1]!] : undefined;
    if (signature) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(signature));
      return;
    }
    const match = req.url?.match(/^\/sync\/seeds\/([0-9a-f]{64})$/);
    const body = match ? seedBodies[match[1]!] : undefined;
    if (body) {
      const rangeMatch = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        const rangeBody = body.subarray(start, end + 1);
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${end}/${body.byteLength}`);
        res.setHeader('content-length', String(rangeBody.length));
        res.end(rangeBody);
      } else {
        res.setHeader('content-length', String(body.length));
        res.end(body);
      }
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('bootstrapAndroidBasisCache', () => {
  const apkBytes = Buffer.from('new apk bytes v2');
  let workDir: string;
  let apkPath: string;
  let basisCacheDir: string;
  let basisPath: string;

  beforeEach(() => {
    workDir = tempDir();
    apkPath = path.join(workDir, 'app-debug.apk');
    fs.writeFileSync(apkPath, apkBytes);
    basisCacheDir = path.join(workDir, 'cache');
    fs.mkdirSync(basisCacheDir);
    basisPath = path.join(basisCacheDir, 'app-debug.apk');
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('keeps a local basis the instance can resolve as a seed', async () => {
    const basisBytes = Buffer.from('old apk bytes v1');
    fs.writeFileSync(basisPath, basisBytes);
    const server = await startServer({ seeds: [{ sha256: sha256Hex(basisBytes), size: basisBytes.length }] });
    try {
      await bootstrapAndroidBasisCache(apkPath, basisCacheDir, server.url, 'tok', noopLog);
    } finally {
      await server.close();
    }
    expect(fs.readFileSync(basisPath)).toEqual(basisBytes);
    expect(server.requests).toEqual(['/sync/state']);
  });

  test('keeps a local basis matching the synced root file', async () => {
    const basisBytes = Buffer.from('old apk bytes v1');
    fs.writeFileSync(basisPath, basisBytes);
    const server = await startServer({
      roots: [{ files: [{ path: 'app-debug.apk', sha256: sha256Hex(basisBytes).toUpperCase() }] }],
    });
    try {
      await bootstrapAndroidBasisCache(apkPath, basisCacheDir, server.url, 'tok', noopLog);
    } finally {
      await server.close();
    }
    expect(fs.readFileSync(basisPath)).toEqual(basisBytes);
  });

  test('replaces a stale local basis with the instance seed', async () => {
    fs.writeFileSync(basisPath, Buffer.from('basis this instance never saw'));
    const seedBytes = Buffer.from('seed apk retained on instance');
    const seedSha = sha256Hex(seedBytes);
    const server = await startServer(
      { seeds: [{ sha256: seedSha, size: seedBytes.length }] },
      { [seedSha]: seedBytes },
    );
    const progress: Array<[number, number]> = [];
    try {
      await bootstrapAndroidBasisCache(apkPath, basisCacheDir, server.url, 'tok', noopLog, (done, total) =>
        progress.push([done, total]),
      );
    } finally {
      await server.close();
    }
    expect(fs.readFileSync(basisPath)).toEqual(seedBytes);
    // Initial (0, expectedSize) announcement, then byte progress ending at the full size.
    expect(progress[0]).toEqual([0, seedBytes.length]);
    expect(progress[progress.length - 1]).toEqual([seedBytes.length, seedBytes.length]);
  });

  test('reconstructs a basis seed from shifted local APK blocks', async () => {
    const blockSize = 8;
    const seedBytes = Buffer.from('abcdefghABCDEFGHijklmnopIJKLMNOP');
    const insertionOffset = blockSize + 3;
    const localBytes = Buffer.concat([
      seedBytes.subarray(0, insertionOffset),
      Buffer.from('shift'),
      seedBytes.subarray(insertionOffset),
    ]);
    fs.writeFileSync(apkPath, localBytes);
    const seedSha = sha256Hex(seedBytes);
    const server = await startServer(
      { seeds: [{ sha256: seedSha, size: seedBytes.length }] },
      { [seedSha]: seedBytes },
      { [seedSha]: signatureFor(seedBytes, blockSize) },
    );
    const progress: Array<[number, number]> = [];
    try {
      await bootstrapAndroidBasisCache(apkPath, basisCacheDir, server.url, 'tok', noopLog, (done, total) =>
        progress.push([done, total]),
      );
    } finally {
      await server.close();
    }

    expect(fs.readFileSync(basisPath)).toEqual(seedBytes);
    expect(server.requests).toEqual(['/sync/state', `/sync/seeds/${seedSha}.sig`, `/sync/seeds/${seedSha}`]);
    expect(progress[0]).toEqual([0, blockSize]);
    expect(progress[progress.length - 1]).toEqual([blockSize, blockSize]);
  });

  test('drops a stale local basis when the instance has nothing usable', async () => {
    fs.writeFileSync(basisPath, Buffer.from('basis this instance never saw'));
    const server = await startServer({});
    try {
      await bootstrapAndroidBasisCache(apkPath, basisCacheDir, server.url, 'tok', noopLog);
    } finally {
      await server.close();
    }
    expect(fs.existsSync(basisPath)).toBe(false);
  });

  test('copies the local APK as basis when the instance already has those bytes', async () => {
    const server = await startServer({ seeds: [{ sha256: sha256Hex(apkBytes), size: apkBytes.length }] });
    try {
      await bootstrapAndroidBasisCache(apkPath, basisCacheDir, server.url, 'tok', noopLog);
    } finally {
      await server.close();
    }
    expect(fs.readFileSync(basisPath)).toEqual(apkBytes);
    expect(server.requests).toEqual(['/sync/state']);
  });

  test('prefers the newest seed when several are available', async () => {
    const oldSeed = Buffer.from('old seed');
    const newSeed = Buffer.from('new seed');
    const server = await startServer(
      {
        seeds: [
          { sha256: sha256Hex(oldSeed), size: oldSeed.length, mtime: 100 },
          { sha256: sha256Hex(newSeed), size: newSeed.length, mtime: 200 },
        ],
      },
      { [sha256Hex(oldSeed)]: oldSeed, [sha256Hex(newSeed)]: newSeed },
    );
    try {
      await bootstrapAndroidBasisCache(apkPath, basisCacheDir, server.url, 'tok', noopLog);
    } finally {
      await server.close();
    }
    expect(fs.readFileSync(basisPath)).toEqual(newSeed);
  });

  test('keeps the local basis when sync state is unavailable', async () => {
    const basisBytes = Buffer.from('basis of unknown standing');
    fs.writeFileSync(basisPath, basisBytes);
    const server = await startServer({});
    await server.close();
    await bootstrapAndroidBasisCache(apkPath, basisCacheDir, server.url, 'tok', noopLog);
    expect(fs.readFileSync(basisPath)).toEqual(basisBytes);
  });
});
