import fs from 'fs';
import os from 'os';
import path from 'path';
import { encodeXdelta3Patch } from '@limrun/api/folder-sync';

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFileBytes(p: string, bytes: Uint8Array): void {
  fs.writeFileSync(p, bytes);
}

describe('encodeXdelta3Patch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir('xdelta3-wasm-test-');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('produces a VCDIFF-magic patch', async () => {
    // VCDIFF magic bytes per RFC 3284: 0xD6 0xC3 0xC4 0x00 (ASCII 'V' 'C' 'D' with high bit set, then version 0).
    const basis = Buffer.from('Hello, world! ' + 'The quick brown fox jumps over the lazy dog. '.repeat(8));
    const target = Buffer.from(
      'Hello, world! ' + 'The quick brown fox jumps over the lazy cat. '.repeat(8) + 'Extra tail bits.',
    );
    const basisPath = path.join(tmpDir, 'basis.bin');
    const targetPath = path.join(tmpDir, 'target.bin');
    const patchPath = path.join(tmpDir, 'patch.xdelta3');
    writeFileBytes(basisPath, basis);
    writeFileBytes(targetPath, target);

    const size = await encodeXdelta3Patch(basisPath, targetPath, patchPath, 1 << 20);

    expect(size).toBeGreaterThan(0);
    const patch = fs.readFileSync(patchPath);
    expect(patch.length).toBe(size);
    expect(patch[0]).toBe(0xd6);
    expect(patch[1]).toBe(0xc3);
    expect(patch[2]).toBe(0xc4);

    expect(size).toBeLessThan(target.length);
  });

  test('returns -1 and writes no file when the patch would exceed maxPatchBytes', async () => {
    // Use incompressible random bytes with no relationship between basis and target so the
    // encoder cannot produce a small delta.
    const basis = Buffer.alloc(128 * 1024);
    const target = Buffer.alloc(128 * 1024);
    for (let i = 0; i < basis.length; i++) basis[i] = (i * 2654435761) & 0xff;
    for (let i = 0; i < target.length; i++) target[i] = (i * 40503) & 0xff;

    const basisPath = path.join(tmpDir, 'basis.bin');
    const targetPath = path.join(tmpDir, 'target.bin');
    const patchPath = path.join(tmpDir, 'patch.xdelta3');
    writeFileBytes(basisPath, basis);
    writeFileBytes(targetPath, target);

    const size = await encodeXdelta3Patch(basisPath, targetPath, patchPath, 16);
    expect(size).toBe(-1);
    expect(fs.existsSync(patchPath)).toBe(false);
  });

  test('supports concurrent patch encodes', async () => {
    const jobs = Array.from({ length: 6 }, (_, index) => {
      const basis = Buffer.from(`basis-${index}:` + 'abcd efgh ijkl mnop '.repeat(4096));
      const target = Buffer.from(`basis-${index}:` + 'abcd efgh ijkl xyz! '.repeat(4096));
      const basisPath = path.join(tmpDir, `basis-${index}.bin`);
      const targetPath = path.join(tmpDir, `target-${index}.bin`);
      const patchPath = path.join(tmpDir, `patch-${index}.xdelta3`);
      writeFileBytes(basisPath, basis);
      writeFileBytes(targetPath, target);
      return { target, basisPath, targetPath, patchPath };
    });

    const sizes = await Promise.all(
      jobs.map((job) => encodeXdelta3Patch(job.basisPath, job.targetPath, job.patchPath, 1 << 20)),
    );

    for (const [index, size] of sizes.entries()) {
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(jobs[index]!.target.length);
      expect(fs.readFileSync(jobs[index]!.patchPath).length).toBe(size);
    }
  });
});
