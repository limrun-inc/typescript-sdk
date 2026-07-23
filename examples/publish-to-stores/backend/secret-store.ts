// A deliberately simple file-based signing-secret store: one JSON file per
// secret under `.secrets/`. It exists to demonstrate that the frontend's
// `SigningSecretStore` interface can be backed by anything — swap this module
// for your own database, KMS, or Limrun's organization secret store without
// touching the wizard. The response shapes match Limrun's org secrets API so
// the frontend store implementation stays a thin fetch wrapper.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StoredSecret = {
  type: string;
  name: string;
  data: Record<string, string>;
  createdAt: string;
};

const SECRETS_DIR = path.join(import.meta.dirname, '.secrets');

// Secret names contain slashes (e.g. TEAMID/DISTRIBUTION), so the file name
// is the URI-encoded `type/name` pair.
function fileOf(type: string, name: string) {
  return path.join(SECRETS_DIR, `${encodeURIComponent(type)}__${encodeURIComponent(name)}.json`);
}

export async function putSecret(
  type: string,
  name: string,
  data: Record<string, string>,
): Promise<StoredSecret> {
  await mkdir(SECRETS_DIR, { recursive: true });
  const existing = await getSecret(type, name);
  const secret: StoredSecret = {
    type,
    name,
    data,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await writeFile(fileOf(type, name), JSON.stringify(secret, null, 2), 'utf8');
  return secret;
}

export async function getSecret(type: string, name: string): Promise<StoredSecret | undefined> {
  try {
    return JSON.parse(await readFile(fileOf(type, name), 'utf8')) as StoredSecret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function listSecrets(): Promise<StoredSecret[]> {
  let files: string[];
  try {
    files = await readdir(SECRETS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const secrets: StoredSecret[] = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    secrets.push(JSON.parse(await readFile(path.join(SECRETS_DIR, file), 'utf8')) as StoredSecret);
  }
  return secrets;
}

export async function deleteSecret(type: string, name: string): Promise<void> {
  await rm(fileOf(type, name), { force: true });
}
