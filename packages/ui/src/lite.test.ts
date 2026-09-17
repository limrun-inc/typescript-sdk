import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Guards the reason the lite entry exists: an embed that imports it must not
// pull the bundled device artwork. Runs against dist, so build first.
const dist = join(__dirname, '..', 'dist');
const describeDist = existsSync(join(dist, 'lite.js')) ? describe : describe.skip;

describeDist('@limrun/ui/lite bundle', () => {
  const chunksOf = (entry: string): string[] => {
    const src = readFileSync(join(dist, entry), 'utf8');
    const chunks = [...src.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]);
    return [src, ...chunks.map((c) => readFileSync(join(dist, c), 'utf8'))];
  };

  test('lite entry and its chunks carry no inlined images', () => {
    for (const code of chunksOf('lite.js')) {
      expect(code).not.toMatch(/data:image\//);
    }
  });

  test('default entry still bundles the device frames (positive control)', () => {
    expect(chunksOf('index.js').some((code) => /data:image\/webp/.test(code))).toBe(true);
  });

  test('one stylesheet keeps its historical name', () => {
    expect(readdirSync(dist).filter((f) => f.endsWith('.css'))).toEqual(['index.css']);
  });
});
