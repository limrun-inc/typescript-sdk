import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalSecretStore } from './local-secret-store';
import { resolveAppleCredentials } from './apple-auth-credentials';
import { cloudSigningFlagsProblem } from './xcode-signing-options';
import * as apple from '@limrun/apple-auth';

describe('saved Apple credentials', () => {
  let directory: string;
  let store: LocalSecretStore;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'lim-apple-'));
    store = new LocalSecretStore(directory);
    await store.put('appStoreConnectApiKey', 'TEAM/APP_STORE_CONNECT_API_KEY', {
      keyId: 'KEY',
      issuerId: 'ISSUER',
      privateKeyP8Base64: 'private',
      teamID: 'TEAM',
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('uses the saved team key for cloud signing', async () => {
    const flags = { 'signing-method': 'app-store-connect' };
    const saved = await resolveAppleCredentials(flags, store);
    expect(saved?.keyId).toBe('KEY');
    expect(cloudSigningFlagsProblem(flags, saved)).toBeUndefined();
  });

  it('requires a selection for multiple teams and never falls back to another team', async () => {
    await store.put('appStoreConnectApiKey', 'OTHER/APP_STORE_CONNECT_API_KEY', {
      keyId: 'OTHER',
      privateKeyP8Base64: 'other',
    });
    await expect(resolveAppleCredentials({}, store)).rejects.toThrow('--team-id');
    expect((await resolveAppleCredentials({ 'team-id': 'TEAM' }, store))?.keyId).toBe('KEY');
    expect(await resolveAppleCredentials({ 'team-id': 'MISSING' }, store)).toBeUndefined();
  });

  it('explicit credentials win as a complete group', async () => {
    const file = path.join(directory, 'explicit.p8');
    await writeFile(file, 'explicit');
    const saved = await resolveAppleCredentials({ 'asc-key-id': 'EXPLICIT', 'asc-key': file }, store);
    expect(saved).toEqual({
      keyId: 'EXPLICIT',
      privateKeyP8Base64: Buffer.from('explicit').toString('base64'),
    });
    await expect(resolveAppleCredentials({ 'asc-key-id': 'EXPLICIT' }, store)).rejects.toThrow('both');
  });

  it('loads the actual publish-to-stores primitives on Node', () => {
    expect(typeof apple.startBrowserOwnedAppleIDLogin).toBe('function');
    expect(typeof apple.ensureAppStoreConnectApiKeySecret).toBe('function');
  });
});
