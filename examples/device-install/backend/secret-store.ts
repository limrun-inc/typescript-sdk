// A deliberately small file-backed SigningSecretStore implementation. Real
// applications can replace this with a database or KMS without changing the
// frontend's Apple credential flow.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StoredSecret = {
  type: string;
  name: string;
  data: Record<string, string>;
  createdAt: string;
};

// The default directory: SECRETS_DIR env or `.secrets` next to the backend.
// Every operation also accepts an explicit directory, which the UI sends so
// multiple examples (e.g. publish-to-stores) can share one store.
export const DEFAULT_SECRETS_DIR = path.resolve(
  process.env['SECRETS_DIR'] ?? path.join(import.meta.dirname, '.secrets'),
);

function resolveDir(dir?: string) {
  const trimmed = dir?.trim();
  return trimmed ? path.resolve(trimmed) : DEFAULT_SECRETS_DIR;
}

function fileOf(type: string, name: string, dir?: string) {
  return path.join(resolveDir(dir), `${encodeURIComponent(type)}__${encodeURIComponent(name)}.json`);
}

export async function putSecret(
  type: string,
  name: string,
  data: Record<string, string>,
  dir?: string,
): Promise<StoredSecret> {
  await mkdir(resolveDir(dir), { recursive: true });
  const existing = await getSecret(type, name, dir);
  const secret: StoredSecret = {
    type,
    name,
    data,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await writeFile(fileOf(type, name, dir), JSON.stringify(secret, null, 2), 'utf8');
  return secret;
}

export async function getSecret(type: string, name: string, dir?: string): Promise<StoredSecret | undefined> {
  try {
    return JSON.parse(await readFile(fileOf(type, name, dir), 'utf8')) as StoredSecret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function listSecrets(dir?: string): Promise<StoredSecret[]> {
  let files: string[];
  try {
    files = await readdir(resolveDir(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const secrets: StoredSecret[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith('.json'))) {
    secrets.push(JSON.parse(await readFile(path.join(resolveDir(dir), file), 'utf8')) as StoredSecret);
  }
  return secrets;
}

export async function deleteSecret(type: string, name: string, dir?: string): Promise<void> {
  await rm(fileOf(type, name, dir), { force: true });
}
