import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import {
  findSeedBlockMatches,
  missingSeedRanges,
  reconstructSeedFromLocalFiles,
  type SeedSignature,
  weakRollingChecksum,
} from '../src/internal/seed-reconstruct';

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function signatureFor(seed: Buffer, blockSize: number): SeedSignature {
  const blocks = [];
  for (let offset = 0; offset < seed.byteLength; offset += blockSize) {
    const block = seed.subarray(offset, Math.min(seed.byteLength, offset + blockSize));
    blocks.push({
      w: weakRollingChecksum(block),
      s: sha256Hex(block).slice(0, 32),
    });
  }
  return {
    version: 1,
    blockSize,
    fileSize: seed.byteLength,
    sha256: sha256Hex(seed),
    blocks,
  };
}

function pseudoRandomBytes(length: number): Buffer {
  const result = Buffer.allocUnsafe(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    result[i] = state >>> 24;
  }
  return result;
}

type SeedServer = {
  url: string;
  requests: string[];
  ranges: string[];
  close: () => Promise<void>;
};

async function startSeedServer(
  seed: Buffer,
  signature: SeedSignature,
  servedSeed = seed,
): Promise<SeedServer> {
  const requests: string[] = [];
  const ranges: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/seed.sig') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(signature));
      return;
    }
    if (request.url === '/seed') {
      const range = request.headers.range;
      if (!range) {
        response.setHeader('content-length', servedSeed.byteLength);
        response.end(servedSeed);
        return;
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) {
        response.statusCode = 416;
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      ranges.push(range);
      const body = servedSeed.subarray(start, end + 1);
      response.statusCode = 206;
      response.setHeader('content-range', `bytes ${start}-${end}/${seed.byteLength}`);
      response.setHeader('content-length', body.byteLength);
      response.end(body);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    ranges,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function reconstruct(
  server: SeedServer,
  signature: SeedSignature,
  sourcePath: string,
  outputPath: string,
  onProgress?: (done: number, total: number) => void,
) {
  return await reconstructSeedFromLocalFiles({
    signatureUrl: `${server.url}/seed.sig`,
    seedUrl: `${server.url}/seed`,
    token: 'test-token',
    sourcePaths: [sourcePath],
    outputPath,
    expectedSha256: signature.sha256,
    ...(onProgress ? { onProgress } : {}),
  });
}

describe('seed reconstruction', () => {
  const blockSize = 64;
  const seed = pseudoRandomBytes(blockSize * 8);
  const signature = signatureFor(seed, blockSize);
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-seed-reconstruct-test-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('uses the same weak checksum layout as the daemon', () => {
    // a = 1+2+3 = 6; b = 3*1 + 2*2 + 1*3 = 10.
    expect(weakRollingChecksum(Buffer.from([1, 2, 3]))).toBe(10 * 0x10000 + 6);
  });

  test.each([
    [
      'inserted',
      Buffer.concat([
        seed.subarray(0, blockSize * 2 + 20),
        Buffer.from('inserted'),
        seed.subarray(blockSize * 2 + 20),
      ]),
    ],
    ['deleted', Buffer.concat([seed.subarray(0, blockSize * 2 + 20), seed.subarray(blockSize * 2 + 27)])],
  ])('finds blocks shifted by %s bytes', async (_kind, localBytes) => {
    const sourcePath = path.join(workDir, 'local.apk');
    fs.writeFileSync(sourcePath, localBytes);

    const matches = await findSeedBlockMatches([sourcePath], signature);

    expect(matches.size).toBe(7);
    expect(missingSeedRanges(signature, matches)).toEqual([{ start: blockSize * 2, end: blockSize * 3 - 1 }]);
  });

  test('uses aligned matches when only a few blocks differ', async () => {
    const localBytes = Buffer.from(seed);
    const changedOffset = blockSize * 3 + 5;
    localBytes[changedOffset] = localBytes[changedOffset]! ^ 0xff;
    const sourcePath = path.join(workDir, 'local.apk');
    fs.writeFileSync(sourcePath, localBytes);

    const matches = await findSeedBlockMatches([sourcePath], signature);

    expect(matches.size).toBe(7);
    expect(missingSeedRanges(signature, matches)).toEqual([{ start: blockSize * 3, end: blockSize * 4 - 1 }]);
  });

  test('matches a shifted trailing partial block at the source end', async () => {
    const partialSeed = pseudoRandomBytes(blockSize * 3 + 17);
    const partialSignature = signatureFor(partialSeed, blockSize);
    const sourcePath = path.join(workDir, 'local.apk');
    fs.writeFileSync(sourcePath, Buffer.concat([Buffer.from('shifted'), partialSeed]));

    const matches = await findSeedBlockMatches([sourcePath], partialSignature);

    expect(matches.size).toBe(partialSignature.blocks.length);
    expect(missingSeedRanges(partialSignature, matches)).toEqual([]);
  });

  test('coalesces adjacent missing blocks into ranges', () => {
    const matches = new Map(
      [0, 1, 4, 5, 7].map((index) => [index, { sourcePath: 'local.apk', sourceOffset: index * blockSize }]),
    );

    expect(missingSeedRanges(signature, matches)).toEqual([
      { start: blockSize * 2, end: blockSize * 4 - 1 },
      { start: blockSize * 6, end: blockSize * 7 - 1 },
    ]);
  });

  test('reconstructs an identical seed without downloading APK bytes', async () => {
    const sourcePath = path.join(workDir, 'local.apk');
    const outputPath = path.join(workDir, 'basis.apk');
    fs.writeFileSync(sourcePath, seed);
    const server = await startSeedServer(seed, signature);
    try {
      const result = await reconstruct(server, signature, sourcePath, outputPath);

      expect(result).toEqual({ downloadedBytes: 0, totalDownloadBytes: 0, matchedBlocks: 8 });
      expect(fs.readFileSync(outputPath)).toEqual(seed);
      expect(server.requests).toEqual(['/seed.sig']);
      expect(server.ranges).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('downloads only the block containing an insertion', async () => {
    const insertionOffset = blockSize * 2 + 20;
    const localBytes = Buffer.concat([
      seed.subarray(0, insertionOffset),
      Buffer.from('inserted'),
      seed.subarray(insertionOffset),
    ]);
    const sourcePath = path.join(workDir, 'local.apk');
    const outputPath = path.join(workDir, 'basis.apk');
    fs.writeFileSync(sourcePath, localBytes);
    const progress: Array<[number, number]> = [];
    const server = await startSeedServer(seed, signature);
    try {
      const result = await reconstruct(server, signature, sourcePath, outputPath, (done, total) => {
        progress.push([done, total]);
      });

      expect(result.downloadedBytes).toBe(blockSize);
      expect(result.matchedBlocks).toBe(7);
      expect(fs.readFileSync(outputPath)).toEqual(seed);
      expect(server.ranges).toEqual([`bytes=${blockSize * 2}-${blockSize * 3 - 1}`]);
      expect(progress[0]).toEqual([0, blockSize]);
      expect(progress[progress.length - 1]).toEqual([blockSize, blockSize]);
    } finally {
      await server.close();
    }
  });

  test('coalesces an unrelated file into one full-file range', async () => {
    const sourcePath = path.join(workDir, 'local.apk');
    const outputPath = path.join(workDir, 'basis.apk');
    fs.writeFileSync(sourcePath, Buffer.alloc(seed.byteLength, 0xff));
    const server = await startSeedServer(seed, signature);
    try {
      const result = await reconstruct(server, signature, sourcePath, outputPath);

      expect(result.downloadedBytes).toBe(seed.byteLength);
      expect(result.matchedBlocks).toBe(0);
      expect(server.ranges).toEqual([`bytes=0-${seed.byteLength - 1}`]);
      expect(fs.readFileSync(outputPath)).toEqual(seed);
    } finally {
      await server.close();
    }
  });

  test('rejects a reconstructed seed that fails final SHA-256 verification', async () => {
    const sourcePath = path.join(workDir, 'local.apk');
    const outputPath = path.join(workDir, 'basis.apk');
    fs.writeFileSync(sourcePath, Buffer.alloc(seed.byteLength, 0xff));
    const corruptedSeed = Buffer.from(seed);
    corruptedSeed[10] = corruptedSeed[10]! ^ 0xff;
    const server = await startSeedServer(seed, signature, corruptedSeed);
    try {
      await expect(reconstruct(server, signature, sourcePath, outputPath)).rejects.toThrow(
        'Reconstructed seed SHA-256 mismatch',
      );
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      await server.close();
    }
  });
});
