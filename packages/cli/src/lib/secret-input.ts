import { createReadStream } from 'node:fs';

export function secretTarget(value: string): string {
  if (!value || /[\0\r\n*?]/.test(value))
    throw new Error('Use a secret ID or an exact name without wildcards.');
  const target =
    /^secret_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(value) || value.startsWith('name/') ? value : `name/${value}`;
  if (target === 'name/' || target.length > 517) throw new Error('Invalid secret name.');
  return target;
}

/** Bound input before requesting a grant, including streams with unknown size. */
export async function secretBytes(file?: string): Promise<Buffer> {
  if ((!file || file === '-') && process.stdin.isTTY)
    throw new Error('Pipe the value on stdin or supply --file PATH.');
  const input = file && file !== '-' ? createReadStream(file) : process.stdin;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 65536) throw new Error('Secret values must be at most 64 KiB.');
    chunks.push(bytes);
  }
  if (!length) throw new Error('Secret values cannot be empty.');
  return Buffer.concat(chunks);
}

export function secretMetadata(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--metadata must be a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('--metadata must be a JSON object.');
  if (Buffer.byteLength(JSON.stringify(parsed)) > 16384)
    throw new Error('Secret metadata must be at most 16 KiB.');
  return parsed as Record<string, unknown>;
}
