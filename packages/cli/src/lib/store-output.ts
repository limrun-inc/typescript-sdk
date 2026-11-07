import { open, rm } from 'node:fs/promises';
import path from 'node:path';

// Reserve the destination before consuming an Apple key's one-time download.
export async function savePrivateFile(file: string, contents: () => Promise<Uint8Array | string>) {
  const output = path.resolve(file);
  const handle = await open(output, 'wx', 0o600);
  let received = false;
  try {
    const data = await contents();
    received = true;
    await handle.writeFile(data);
    return { output };
  } catch (error) {
    if (!received) await rm(output, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

export function downloadBytes(response: { rawBodyBase64?: string }) {
  if (!response.rawBodyBase64) throw new Error('Apple returned no download bytes.');
  return Buffer.from(response.rawBodyBase64, 'base64');
}
