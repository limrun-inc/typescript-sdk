import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

import { nodeProxyTransport } from './proxy-transport';

const SIGNATURE_VERSION = 1;
const STRONG_HASH_HEX_LENGTH = 32;
const SCAN_CHUNK_SIZE = 1024 * 1024;
const MAX_ALIGNED_MISS_BYTES = 32 * 1024 * 1024;

export type SeedSignatureBlock = {
  w: number;
  s: string;
};

export type SeedSignature = {
  version: number;
  blockSize: number;
  fileSize: number;
  sha256: string;
  blocks: SeedSignatureBlock[];
};

export type SeedBlockMatch = {
  sourcePath: string;
  sourceOffset: number;
};

export type SeedByteRange = {
  start: number;
  end: number;
};

type ReconstructSeedOptions = {
  signatureUrl: string;
  seedUrl: string;
  token: string;
  sourcePaths: string[];
  outputPath: string;
  expectedSha256: string;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
};

function strongHash(buffer: Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, STRONG_HASH_HEX_LENGTH);
}

async function sha256FileHex(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function weakRollingChecksum(buffer: Uint8Array): number {
  let a = 0;
  let b = 0;
  for (let i = 0; i < buffer.byteLength; i++) {
    const value = buffer[i]!;
    a = (a + value) & 0xffff;
    b = (b + (buffer.byteLength - i) * value) & 0xffff;
  }
  return b * 0x10000 + a;
}

function validateSignature(value: unknown, expectedSha256: string): SeedSignature {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid seed signature: expected an object');
  }
  const candidate = value as Partial<SeedSignature>;
  if (candidate.version !== SIGNATURE_VERSION) {
    throw new Error(`Unsupported seed signature version: ${String(candidate.version)}`);
  }
  if (!Number.isSafeInteger(candidate.blockSize) || candidate.blockSize! <= 0) {
    throw new Error('Invalid seed signature blockSize');
  }
  if (!Number.isSafeInteger(candidate.fileSize) || candidate.fileSize! < 0) {
    throw new Error('Invalid seed signature fileSize');
  }
  if (
    typeof candidate.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(candidate.sha256) ||
    candidate.sha256.toLowerCase() !== expectedSha256.toLowerCase()
  ) {
    throw new Error('Seed signature sha256 does not match the requested seed');
  }
  if (!Array.isArray(candidate.blocks)) {
    throw new Error('Invalid seed signature blocks');
  }
  const expectedBlocks = Math.ceil(candidate.fileSize! / candidate.blockSize!);
  if (candidate.blocks.length !== expectedBlocks) {
    throw new Error(
      `Invalid seed signature block count: got ${candidate.blocks.length}, expected ${expectedBlocks}`,
    );
  }
  const blocks = candidate.blocks.map((block, index) => {
    if (
      !block ||
      !Number.isInteger(block.w) ||
      block.w < 0 ||
      block.w > 0xffffffff ||
      typeof block.s !== 'string' ||
      !new RegExp(`^[0-9a-f]{${STRONG_HASH_HEX_LENGTH}}$`, 'i').test(block.s)
    ) {
      throw new Error(`Invalid seed signature block at index ${index}`);
    }
    return { w: block.w, s: block.s.toLowerCase() };
  });
  return {
    version: candidate.version,
    blockSize: candidate.blockSize!,
    fileSize: candidate.fileSize!,
    sha256: candidate.sha256.toLowerCase(),
    blocks,
  };
}

export async function fetchSeedSignature(
  signatureUrl: string,
  token: string,
  expectedSha256: string,
): Promise<SeedSignature> {
  const response = await nodeProxyTransport.fetch(signatureUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Seed signature download failed: ${response.status} ${body}`);
  }
  return validateSignature(await response.json(), expectedSha256);
}

async function readExactly(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) {
      throw new Error(`Unexpected EOF at offset ${position + offset}`);
    }
    offset += bytesRead;
  }
}

async function scanSourceForBlockLength(
  sourcePath: string,
  blockLength: number,
  candidatesByWeak: Map<number, number[]>,
  signature: SeedSignature,
  matches: Map<number, SeedBlockMatch>,
  unmatched: Set<number>,
): Promise<void> {
  const handle = await fs.promises.open(sourcePath, 'r');
  try {
    const sourceSize = (await handle.stat()).size;
    if (sourceSize < blockLength || unmatched.size === 0) {
      return;
    }

    const ring = Buffer.allocUnsafe(blockLength);
    await readExactly(handle, ring, blockLength, 0);
    let a = 0;
    let b = 0;
    for (let i = 0; i < blockLength; i++) {
      const value = ring[i]!;
      a = (a + value) & 0xffff;
      b = (b + (blockLength - i) * value) & 0xffff;
    }

    let ringPosition = 0;
    let sourceOffset = 0;
    let candidateBuffer: Buffer | undefined;
    const confirmCandidate = async (candidateIndexes: number[]) => {
      candidateBuffer ??= Buffer.allocUnsafe(blockLength);
      await readExactly(handle, candidateBuffer, blockLength, sourceOffset);
      const strong = strongHash(candidateBuffer);
      for (const index of candidateIndexes) {
        if (unmatched.has(index) && signature.blocks[index]!.s === strong) {
          matches.set(index, { sourcePath, sourceOffset });
          unmatched.delete(index);
        }
      }
    };

    let candidateIndexes = candidatesByWeak.get(b * 0x10000 + a);
    if (candidateIndexes?.some((index) => unmatched.has(index))) {
      await confirmCandidate(candidateIndexes);
    }
    const incoming = Buffer.allocUnsafe(SCAN_CHUNK_SIZE);
    let readPosition = blockLength;
    while (readPosition < sourceSize && unmatched.size > 0) {
      const requested = Math.min(incoming.byteLength, sourceSize - readPosition);
      const { bytesRead } = await handle.read(incoming, 0, requested, readPosition);
      if (bytesRead <= 0) {
        break;
      }
      for (let i = 0; i < bytesRead && unmatched.size > 0; i++) {
        const outgoingValue = ring[ringPosition]!;
        const incomingValue = incoming[i]!;
        ring[ringPosition] = incomingValue;
        ringPosition++;
        if (ringPosition === blockLength) {
          ringPosition = 0;
        }
        a = (a - outgoingValue + incomingValue) & 0xffff;
        b = (b - ((blockLength * outgoingValue) & 0xffff) + a) & 0xffff;
        sourceOffset++;
        candidateIndexes = candidatesByWeak.get(b * 0x10000 + a);
        if (candidateIndexes?.some((index) => unmatched.has(index))) {
          await confirmCandidate(candidateIndexes);
        }
      }
      readPosition += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

export async function findSeedBlockMatches(
  sourcePaths: string[],
  signature: SeedSignature,
): Promise<Map<number, SeedBlockMatch>> {
  const matches = new Map<number, SeedBlockMatch>();

  // APK rebuilds commonly preserve ZIP entry offsets. Check blocks at their
  // target offsets first using native SHA-256, which is dramatically faster
  // than a byte-by-byte rolling scan for large files.
  for (const sourcePath of sourcePaths) {
    const stat = await fs.promises.stat(sourcePath).catch(() => undefined);
    if (!stat?.isFile()) {
      continue;
    }
    const handle = await fs.promises.open(sourcePath, 'r');
    const block = Buffer.allocUnsafe(signature.blockSize);
    try {
      for (let index = 0; index < signature.blocks.length; index++) {
        if (matches.has(index)) {
          continue;
        }
        const sourceOffset = index * signature.blockSize;
        const length = Math.min(signature.blockSize, signature.fileSize - sourceOffset);
        if (sourceOffset + length > stat.size) {
          continue;
        }
        await readExactly(handle, block, length, sourceOffset);
        if (strongHash(block.subarray(0, length)) === signature.blocks[index]!.s) {
          matches.set(index, { sourcePath, sourceOffset });
        }
      }
    } finally {
      await handle.close();
    }
  }

  const alignedMissBytes = signature.blocks.reduce((total, _block, index) => {
    if (matches.has(index)) {
      return total;
    }
    const offset = index * signature.blockSize;
    return total + Math.min(signature.blockSize, signature.fileSize - offset);
  }, 0);
  const alignedMatchRatio = signature.blocks.length === 0 ? 1 : matches.size / signature.blocks.length;
  if (alignedMatchRatio >= 0.8 && alignedMissBytes <= MAX_ALIGNED_MISS_BYTES) {
    return matches;
  }

  const indexesByLength = new Map<number, number[]>();
  for (let index = 0; index < signature.blocks.length; index++) {
    if (matches.has(index)) {
      continue;
    }
    const offset = index * signature.blockSize;
    const length = Math.min(signature.blockSize, signature.fileSize - offset);
    const indexes = indexesByLength.get(length) ?? [];
    indexes.push(index);
    indexesByLength.set(length, indexes);
  }

  for (const [blockLength, indexes] of indexesByLength) {
    // A trailing partial block is worth at most one block of transfer savings.
    // Avoid a second byte-by-byte scan of the whole APK: check the seed's
    // expected offset and the end of each source, which cover unchanged layout
    // and suffix-aligned rebuilds respectively.
    if (blockLength !== signature.blockSize) {
      const index = indexes[0]!;
      const expected = signature.blocks[index]!;
      for (const sourcePath of sourcePaths) {
        const stat = await fs.promises.stat(sourcePath).catch(() => undefined);
        if (!stat?.isFile() || stat.size < blockLength) {
          continue;
        }
        const offsets = new Set([index * signature.blockSize, stat.size - blockLength]);
        const handle = await fs.promises.open(sourcePath, 'r');
        try {
          for (const sourceOffset of offsets) {
            if (sourceOffset < 0 || sourceOffset + blockLength > stat.size) {
              continue;
            }
            const block = Buffer.allocUnsafe(blockLength);
            await readExactly(handle, block, blockLength, sourceOffset);
            if (weakRollingChecksum(block) === expected.w && strongHash(block) === expected.s) {
              matches.set(index, { sourcePath, sourceOffset });
              break;
            }
          }
        } finally {
          await handle.close();
        }
        if (matches.has(index)) {
          break;
        }
      }
      continue;
    }

    const candidatesByWeak = new Map<number, number[]>();
    for (const index of indexes) {
      const weak = signature.blocks[index]!.w;
      const candidates = candidatesByWeak.get(weak) ?? [];
      candidates.push(index);
      candidatesByWeak.set(weak, candidates);
    }
    const unmatched = new Set(indexes);
    for (const sourcePath of sourcePaths) {
      const stat = await fs.promises.stat(sourcePath).catch(() => undefined);
      if (!stat?.isFile()) {
        continue;
      }
      await scanSourceForBlockLength(
        sourcePath,
        blockLength,
        candidatesByWeak,
        signature,
        matches,
        unmatched,
      );
      if (unmatched.size === 0) {
        break;
      }
    }
  }
  return matches;
}

export function missingSeedRanges(
  signature: SeedSignature,
  matches: ReadonlyMap<number, SeedBlockMatch>,
): SeedByteRange[] {
  const ranges: SeedByteRange[] = [];
  let startBlock: number | undefined;
  for (let index = 0; index <= signature.blocks.length; index++) {
    const missing = index < signature.blocks.length && !matches.has(index);
    if (missing && startBlock === undefined) {
      startBlock = index;
    } else if (!missing && startBlock !== undefined) {
      ranges.push({
        start: startBlock * signature.blockSize,
        end: Math.min(signature.fileSize, index * signature.blockSize) - 1,
      });
      startBlock = undefined;
    }
  }
  return ranges;
}

async function copyMatchedBlocks(
  output: fs.promises.FileHandle,
  signature: SeedSignature,
  matches: ReadonlyMap<number, SeedBlockMatch>,
): Promise<void> {
  const sourceHandles = new Map<string, fs.promises.FileHandle>();
  try {
    for (const [index, match] of matches) {
      let source = sourceHandles.get(match.sourcePath);
      if (!source) {
        source = await fs.promises.open(match.sourcePath, 'r');
        sourceHandles.set(match.sourcePath, source);
      }
      const targetOffset = index * signature.blockSize;
      const length = Math.min(signature.blockSize, signature.fileSize - targetOffset);
      const block = Buffer.allocUnsafe(length);
      await readExactly(source, block, length, match.sourceOffset);
      await writeExactly(output, block, targetOffset);
    }
  } finally {
    await Promise.all([...sourceHandles.values()].map((handle) => handle.close()));
  }
}

async function writeExactly(handle: fs.promises.FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (bytesWritten <= 0) {
      throw new Error(`Unable to write reconstructed seed at offset ${position + offset}`);
    }
    offset += bytesWritten;
  }
}

async function downloadRange(
  seedUrl: string,
  token: string,
  range: SeedByteRange,
  fileSize: number,
  output: fs.promises.FileHandle,
  reportBytes: (bytes: number) => void,
): Promise<void> {
  const response = await nodeProxyTransport.fetch(seedUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Range: `bytes=${range.start}-${range.end}`,
    },
  });
  if (response.status !== 206 || !response.body) {
    const body = await response.text();
    throw new Error(`Seed range download failed: ${response.status} ${body}`);
  }
  const expectedContentRange = `bytes ${range.start}-${range.end}/${fileSize}`;
  if (response.headers.get('content-range') !== expectedContentRange) {
    throw new Error(
      `Invalid Content-Range for seed: ${response.headers.get('content-range') ?? '<missing>'}`,
    );
  }

  const expectedLength = range.end - range.start + 1;
  let received = 0;
  const source = Readable.fromWeb(response.body as any);
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    if (received + chunk.byteLength > expectedLength) {
      throw new Error('Seed range response exceeded the requested length');
    }
    await writeExactly(output, chunk, range.start + received);
    received += chunk.byteLength;
    reportBytes(chunk.byteLength);
  }
  if (received !== expectedLength) {
    throw new Error(`Seed range response was truncated: got ${received}, expected ${expectedLength}`);
  }
}

export async function reconstructSeedFromLocalFiles(options: ReconstructSeedOptions): Promise<{
  downloadedBytes: number;
  totalDownloadBytes: number;
  matchedBlocks: number;
}> {
  const expectedSha256 = options.expectedSha256.toLowerCase();
  const signature = await fetchSeedSignature(options.signatureUrl, options.token, expectedSha256);
  const uniqueSources = [...new Set(options.sourcePaths.map((sourcePath) => path.resolve(sourcePath)))];
  const matches = await findSeedBlockMatches(uniqueSources, signature);
  const ranges = missingSeedRanges(signature, matches);
  const totalDownloadBytes = ranges.reduce((total, range) => total + range.end - range.start + 1, 0);
  let downloadedBytes = 0;
  options.onProgress?.(0, totalDownloadBytes);

  await fs.promises.mkdir(path.dirname(options.outputPath), { recursive: true });
  const temporaryPath = `${options.outputPath}.reconstruct-${process.pid}-${crypto
    .randomBytes(6)
    .toString('hex')}`;
  const output = await fs.promises.open(temporaryPath, 'wx');
  let outputClosed = false;
  let installed = false;
  try {
    await output.truncate(signature.fileSize);
    await copyMatchedBlocks(output, signature, matches);
    for (const range of ranges) {
      await downloadRange(options.seedUrl, options.token, range, signature.fileSize, output, (bytes) => {
        downloadedBytes += bytes;
        options.onProgress?.(downloadedBytes, totalDownloadBytes);
      });
    }
    await output.close();
    outputClosed = true;

    const actualSha256 = await sha256FileHex(temporaryPath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Reconstructed seed SHA-256 mismatch: got ${actualSha256}, expected ${expectedSha256}`);
    }
    await fs.promises.rm(options.outputPath, { force: true });
    await fs.promises.rename(temporaryPath, options.outputPath);
    installed = true;
  } finally {
    if (!outputClosed) {
      await output.close().catch(() => undefined);
    }
    if (!installed) {
      await fs.promises.rm(temporaryPath, { force: true });
    }
  }

  return { downloadedBytes, totalDownloadBytes, matchedBlocks: matches.size };
}
