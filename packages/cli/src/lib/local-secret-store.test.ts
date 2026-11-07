import { mkdtemp, readFile, readdir, rm, stat, chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalSecretStore } from './local-secret-store';

describe('local signing secrets', () => {
  let directory: string;
  let store: LocalSecretStore;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'lim-secrets-'));
    store = new LocalSecretStore(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists slash-containing names privately and never exposes data in listings', async () => {
    const name = '../../TEAM/APP_STORE_CONNECT_API_KEY';
    await store.put('appStoreConnectApiKey', name, { keyId: 'KEY', privateKeyP8Base64: 'private' });
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const file = path.join(directory, files[0]!);
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await store.list())[0]).not.toHaveProperty('data');
    expect((await store.get('appStoreConnectApiKey', name))?.data.keyId).toBe('KEY');
    // Replacing a legacy permissive file restores its permissions atomically.
    await chmod(file, 0o644);
    await store.put('appStoreConnectApiKey', name, { keyId: 'NEW' });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toContain('private');
    expect(await readdir(directory)).toHaveLength(1);
    await store.delete('appStoreConnectApiKey', name);
    expect(await store.get('appStoreConnectApiKey', name)).toBeUndefined();
  });

  it('does not silently replace malformed credentials', async () => {
    await writeFile(path.join(directory, 'googlePlayOAuth__default.json'), 'SENSITIVE_TOKEN');
    await expect(store.put('googlePlayOAuth', 'default', { refreshToken: 'new' })).rejects.toThrow(
      'Invalid local secret file',
    );
    await expect(store.get('googlePlayOAuth', 'default')).rejects.not.toThrow('SENSITIVE_TOKEN');
  });

  it('never replaces an upload key when two processes create it concurrently', async () => {
    const results = await Promise.allSettled([
      store.create('androidSigningKey', 'com.example.app', { key: 'first' }),
      store.create('androidSigningKey', 'com.example.app', { key: 'second' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<LocalSecretStore['create']>>
    >;
    expect((await store.get('androidSigningKey', 'com.example.app'))?.data).toEqual(winner.value.data);
    expect(await readdir(directory)).toHaveLength(1);
  });
});
