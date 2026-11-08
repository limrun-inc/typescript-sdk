import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile, chmod, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface LocalSecret {
  type: string;
  name: string;
  data: Record<string, string>;
  createdAt: string;
}

// Uses the publish-to-stores SigningSecretStore shape, with files owned by this user.
export class LocalSecretStore {
  constructor(readonly directory = path.join(os.homedir(), '.lim', 'secrets')) {}

  private file(type: string, name: string): string {
    return path.join(this.directory, `${encodeURIComponent(type)}__${encodeURIComponent(name)}.json`);
  }

  async get(type: string, name: string): Promise<LocalSecret | undefined> {
    try {
      const secret = parseSecret(await readFile(this.file(type, name), 'utf8'));
      if (
        secret.type !== type ||
        secret.name !== name ||
        !secret.data ||
        typeof secret.data !== 'object' ||
        Array.isArray(secret.data) ||
        !Object.values(secret.data).every((value) => typeof value === 'string')
      ) {
        throw new Error('Invalid local secret file.');
      }
      return secret;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(type: string, name: string, data: Record<string, string>): Promise<LocalSecret> {
    return this.write(type, name, data, true);
  }

  // Upload keys must survive concurrent generation attempts for the same app.
  async create(type: string, name: string, data: Record<string, string>): Promise<LocalSecret> {
    return this.write(type, name, data, false);
  }

  private async write(
    type: string,
    name: string,
    data: Record<string, string>,
    replace: boolean,
  ): Promise<LocalSecret> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const existing = await this.get(type, name);
    const secret = { type, name, data, createdAt: existing?.createdAt ?? new Date().toISOString() };
    const file = this.file(type, name);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(secret, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      if (replace) await rename(temporary, file);
      else await link(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    return secret;
  }

  async list(): Promise<Omit<LocalSecret, 'data'>[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: Omit<LocalSecret, 'data'>[] = [];
    for (const file of files.filter((file) => file.endsWith('.json'))) {
      const { type, name, createdAt } = parseSecret(await readFile(path.join(this.directory, file), 'utf8'));
      result.push({ type, name, createdAt });
    }
    return result;
  }

  async delete(type: string, name: string): Promise<void> {
    await rm(this.file(type, name), { force: true });
  }
}

function parseSecret(content: string): LocalSecret {
  try {
    const secret = JSON.parse(content);
    if (
      !secret ||
      typeof secret !== 'object' ||
      typeof secret.type !== 'string' ||
      typeof secret.name !== 'string'
    ) {
      throw new Error('Invalid secret');
    }
    return secret;
  } catch {
    // JSON parser messages can include the credential bytes around a syntax error.
    throw new Error('Invalid local secret file. Restore it from a backup or sign in again.');
  }
}
