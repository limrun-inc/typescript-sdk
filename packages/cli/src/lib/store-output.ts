import { open, rm, type FileHandle } from 'node:fs/promises';
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

// Reserve every destination first; a failed local export must be safe to retry.
export async function savePrivateFiles(
  files: string[],
  contents: () => Promise<(Uint8Array | string)[]>,
): Promise<void> {
  const reserved: { output: string; handle: FileHandle }[] = [];
  try {
    try {
      for (const file of files) {
        const output = path.resolve(file);
        reserved.push({ output, handle: await open(output, 'wx', 0o600) });
      }
      const data = await contents();
      if (data.length !== reserved.length) throw new Error('Missing private file contents.');
      for (const [index, { handle }] of reserved.entries()) await handle.writeFile(data[index]!);
    } finally {
      await Promise.all(reserved.map(({ handle }) => handle.close()));
    }
  } catch (error) {
    await Promise.all(reserved.map(({ output }) => rm(output, { force: true })));
    throw error;
  }
}
