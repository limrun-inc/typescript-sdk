import { expect, it, vi } from 'vitest';

// meshopt's decoder compiles WebAssembly when its module loads, so loading the module is what a
// strict content security policy refuses. It must load only to decode a compressed model.
const decoder = vi.hoisted(() => ({
  loaded: false,
  decodeGltfBuffer: vi.fn((target: Uint8Array) => target.fill(7)),
}));
vi.mock('three/addons/libs/meshopt_decoder.module.js', () => {
  decoder.loaded = true;
  return { MeshoptDecoder: { ready: Promise.resolve(), decodeGltfBuffer: decoder.decodeGltfBuffer } };
});

it('loads the meshopt decoder only to decode a compressed buffer', async () => {
  const { lazyMeshoptDecoder } = await import('./model-source');
  expect(decoder.loaded).toBe(false);
  const source = new Uint8Array([1, 2, 3]);
  const decoded = await (
    lazyMeshoptDecoder as unknown as {
      decodeGltfBufferAsync(
        count: number,
        stride: number,
        source: Uint8Array,
        mode: string,
        filter?: string,
      ): Promise<Uint8Array>;
    }
  ).decodeGltfBufferAsync(2, 4, source, 'ATTRIBUTES', 'NONE');
  expect(decoder.loaded).toBe(true);
  expect(decoder.decodeGltfBuffer).toHaveBeenCalledWith(
    expect.any(Uint8Array),
    2,
    4,
    source,
    'ATTRIBUTES',
    'NONE',
  );
  expect(decoded).toEqual(new Uint8Array(8).fill(7));
});
