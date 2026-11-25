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

  // Every chunk an entry can reach, through static and dynamic imports.
  const reachable = (entry: string): string[] => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(join(dist, file), 'utf8');
      for (const m of src.matchAll(/(?:from |import\()"\.\/([^"]+)"/g)) visit(m[1]!);
    };
    visit(entry);
    return [...seen].map((file) => readFileSync(join(dist, file), 'utf8'));
  };

  test('the default entry loads its 3D models only through dynamic imports', () => {
    expect(chunksOf('index.js').some((code) => code.includes('data:model/gltf-binary'))).toBe(false);
    // The iPhone Duo's and the MacBook's.
    expect(reachable('index.js').filter((code) => code.includes('data:model/gltf-binary'))).toHaveLength(2);
  });

  test('lite entry reaches no bundled models', () => {
    for (const code of reachable('lite.js')) expect(code).not.toContain('data:model/gltf-binary');
  });

  test('one stylesheet keeps its historical name', () => {
    expect(readdirSync(dist).filter((f) => f.endsWith('.css'))).toEqual(['index.css']);
  });
});
