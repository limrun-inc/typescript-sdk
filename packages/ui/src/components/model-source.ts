import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { RemoteControlModel } from './remote-control';

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
 * security policy limits connect-src still loads it.
 */
export async function loadModel(loader: GLTFLoader, source: RemoteControlModel): Promise<GLTF> {
  const url = typeof source === 'string' ? source : await source();
  return url.startsWith('data:') ? loader.parseAsync(dataUrlBytes(url), '') : loader.loadAsync(url);
}
