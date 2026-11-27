import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { RemoteControlModel } from './remote-control';

// meshopt's decoder compiles WebAssembly as soon as its module loads, which a page whose content
// security policy lacks 'wasm-unsafe-eval' refuses. This stands in for it and loads the real one
// only to decode a model that uses EXT_meshopt_compression, so a model without it loads anywhere.
export const lazyMeshoptDecoder = {
  supported: typeof WebAssembly === 'object',
  async decodeGltfBufferAsync(
    count: number,
    stride: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ): Promise<Uint8Array> {
    const { MeshoptDecoder: decoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    await decoder.ready;
    const target = new Uint8Array(count * stride);
    decoder.decodeGltfBuffer(target, count, stride, source, mode, filter);
    return target;
  },
} as unknown as typeof MeshoptDecoder;

// The bytes of a data URL.
function dataUrlBytes(url: string): ArrayBuffer {
  const comma = url.indexOf(',');
  const header = url.slice(0, comma);
  const body = url.slice(comma + 1);
  if (!header.endsWith(';base64')) return new TextEncoder().encode(decodeURIComponent(body)).buffer;
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Loads a 3D device's model from a URL, or from the function that resolves to one. A bundled model
 * arrives as a data URL, which is decoded here rather than fetched, so a page whose content
 * security policy limits connect-src still loads it. A meshopt-compressed model decodes too, where
 * the page allows WebAssembly.
 */
export async function loadModel(loader: GLTFLoader, source: RemoteControlModel): Promise<GLTF> {
  loader.setMeshoptDecoder(lazyMeshoptDecoder);
  const url = typeof source === 'string' ? source : await source();
  return url.startsWith('data:') ? loader.parseAsync(dataUrlBytes(url), '') : loader.loadAsync(url);
}
