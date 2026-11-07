import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { inflateRawSync } from 'zlib';
import { deflateRaw } from 'pako';
import yauzl from 'yauzl';

type Span = { offset: number; size: number; expandedSize: number; level: number };
const MAX_ENTRY = 64 * 1024 * 1024;

// Keep bytes outside selected DEFLATE streams verbatim, including APK signatures.
// Large individual streams remain compressed to bound memory during encoding.
async function expand(input: string, output: string, target: boolean): Promise<Span[]> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(input, { lazyEntries: true, autoClose: false }, (err, file) => {
      if (err || !file) reject(err ?? new Error('Cannot open APK'));
      else resolve(file);
    });
  });
  const entries: yauzl.Entry[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.on('end', resolve);
      zip.on('error', reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  const source = await fs.promises.open(input, 'r');
  const dest = await fs.promises.open(output, 'w');
  const spans: Span[] = [];
  let cursor = 0;
  let outputSize = 0;
  const write = async (data: Buffer) => {
    let written = 0;
    while (written < data.length) {
      const result = await dest.write(data, written, data.length - written, outputSize);
      if (!result.bytesWritten) throw new Error('Cannot write transformed APK');
      written += result.bytesWritten;
      outputSize += result.bytesWritten;
    }
  };
  const copy = async (end: number) => {
    if (end < cursor) throw new Error('Overlapping ZIP entries');
    const buffer = Buffer.alloc(1024 * 1024);
    while (cursor < end) {
      const result = await source.read(buffer, 0, Math.min(buffer.length, end - cursor), cursor);
      if (!result.bytesRead) throw new Error('Truncated ZIP');
      await write(buffer.subarray(0, result.bytesRead));
      cursor += result.bytesRead;
    }
  };
  try {
    entries.sort((a, b) => a.relativeOffsetOfLocalHeader - b.relativeOffsetOfLocalHeader);
    for (const entry of entries) {
      if (
        entry.compressionMethod !== 8 ||
        entry.isEncrypted() ||
        entry.uncompressedSize > MAX_ENTRY ||
        entry.compressedSize > MAX_ENTRY
      )
        continue;
      const header = Buffer.alloc(30);
      const read = await source.read(header, 0, 30, entry.relativeOffsetOfLocalHeader);
      if (read.bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50)
        throw new Error('Invalid ZIP header');
      const offset =
        entry.relativeOffsetOfLocalHeader + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const raw = Buffer.alloc(entry.compressedSize);
      if ((await source.read(raw, 0, raw.length, offset)).bytesRead !== raw.length)
        throw new Error('Truncated ZIP entry');
      const expanded = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
      if (expanded.length !== entry.uncompressedSize) throw new Error('Invalid ZIP entry size');
      let level = 0;
      if (target) {
        // Node's patched zlib can emit different bytes from Android's zlib.
        // Use the canonical zlib hash on every Node version and platform.
        const match = [6, 9, 1, 2, 3, 4, 5, 7, 8].find((candidate) =>
          Buffer.from(deflateRaw(expanded, { level: candidate, legacyHash: true })).equals(raw),
        );
        if (match === undefined) continue;
        level = match;
      }
      await copy(offset);
      await write(expanded);
      cursor += raw.length;
      spans.push({ offset, size: raw.length, expandedSize: expanded.length, level });
    }
    await copy((await source.stat()).size);
    return spans;
  } finally {
    await source.close();
    await dest.close();
  }
}

export async function encodeApkDelta(
  basis: string,
  target: string,
  patch: string,
  maxBytes: number,
  encode: (basis: string, target: string, patch: string, maxBytes: number) => Promise<number>,
): Promise<number> {
  const dir = await fs.promises.mkdtemp(path.join(path.dirname(patch), 'apk-'));
  try {
    const oldFile = path.join(dir, 'old');
    const newFile = path.join(dir, 'new');
    const old = await expand(basis, oldFile, false);
    const next = await expand(target, newFile, true);
    if (next.length === 0) return -1;
    const header = Buffer.from(
      JSON.stringify({
        version: 1,
        old,
        next,
        oldSize: (await fs.promises.stat(basis)).size,
        newSize: (await fs.promises.stat(target)).size,
      }),
    );
    if (header.length > 4 * 1024 * 1024) return -1;
    const delta = path.join(dir, 'delta');
    const size = await encode(oldFile, newFile, delta, maxBytes - header.length - 4);
    if (size < 0) return -1;
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(header.length);
    await fs.promises.writeFile(patch, Buffer.concat([prefix, header]));
    await pipeline(fs.createReadStream(delta), fs.createWriteStream(patch, { flags: 'a' }));
    return size + header.length + 4;
  } catch {
    return -1;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
