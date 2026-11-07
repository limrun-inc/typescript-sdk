import { readFile } from 'node:fs/promises';
import { LocalSecretStore } from './local-secret-store';
import type { XcodeCloudSigningFlagValues } from './xcode-signing-options';

export interface AppleCredentials {
  keyId: string;
  privateKeyP8Base64: string;
  issuerId?: string;
  teamID?: string;
}

export async function resolveAppleCredentials(
  flags: XcodeCloudSigningFlagValues,
  store = new LocalSecretStore(),
): Promise<AppleCredentials | undefined> {
  // Never combine part of an explicit credential with a different saved key.
  if (
    flags['asc-key'] !== undefined ||
    flags['asc-key-id'] !== undefined ||
    flags['asc-issuer-id'] !== undefined
  ) {
    if (!flags['asc-key'] || !flags['asc-key-id']) {
      throw new Error('Explicit App Store Connect credentials require both --asc-key-id and --asc-key.');
    }
    return {
      keyId: flags['asc-key-id'],
      privateKeyP8Base64: (await readFile(flags['asc-key'])).toString('base64'),
      issuerId: flags['asc-issuer-id'],
      teamID: flags['team-id'],
    };
  }
  const keys = (await store.list()).filter(
    (secret) =>
      secret.type === 'appStoreConnectApiKey' &&
      (!flags['team-id'] || secret.name === `${flags['team-id']}/APP_STORE_CONNECT_API_KEY`),
  );
  if (!keys.length) return undefined;
  if (keys.length > 1) throw new Error('Several Apple teams are saved. Select one with --team-id.');
  const saved = await store.get('appStoreConnectApiKey', keys[0]!.name);
  if (!saved?.data.keyId || !saved.data.privateKeyP8Base64) {
    throw new Error('Saved Apple credentials are incomplete. Run lim ios apple auth again.');
  }
  return {
    keyId: saved.data.keyId,
    privateKeyP8Base64: saved.data.privateKeyP8Base64,
    issuerId: saved.data.issuerId,
    teamID: saved.data.teamID,
  };
}
