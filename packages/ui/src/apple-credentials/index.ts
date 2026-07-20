/**
 * Headless helpers that turn an authenticated Apple relay session into
 * signing credentials persisted in a SigningSecretStore. The Apple relay
 * only proxies: certificate and profile bytes always land in the browser
 * first, and the browser writes them into the configured store (Limrun's
 * org secret store by default, or a customer-provided one).
 */
import {
  createAppleCertificate,
  createAppStoreConnectApiKey,
  downloadAppleCertificate,
  downloadAppleProfile,
  downloadAppStoreConnectApiKeyPrivateKey,
  exportAppleCertificateP12,
  fetchAppStoreConnectIssuerId,
  generateAppleSigningKeyAndCSR,
  listAppleCertificates,
  listAppleProfiles,
  listAppStoreConnectApiKeys,
  switchAppStoreConnectProvider,
  type AppleCertificateKind,
  type AppleProfileKind,
  type AppStoreConnectApiKeyRole,
} from '../app-store-relay';
import type { AppleRelayWebSocketClient } from '../core/device-install/apple';
import {
  normalizeCertificateSerial,
  parseProvisioningProfileBase64,
} from '../core/device-install/storage/browser-storage';
import {
  APP_STORE_CONNECT_API_KEY_SECRET_TYPE,
  APPLE_CERTIFICATE_SECRET_TYPE,
  putAppleCertificateSecret,
  putAppleProvisioningProfileSecret,
  putAppStoreConnectApiKeySecret,
  type AppleCertificateSecretData,
  type AppleCertificateType,
  type AppStoreConnectApiKeySecretData,
  type SigningSecret,
  type SigningSecretStore,
} from '../core/device-install/storage/secret-store';

export {
  APP_STORE_CONNECT_API_KEY_SECRET_TYPE,
  APPLE_CERTIFICATE_SECRET_TYPE,
  APPLE_PROVISIONING_PROFILE_SECRET_TYPE,
  createBrowserSecretStore,
  createLimrunSecretStore,
  putAppleCertificateSecret,
  putAppleProvisioningProfileSecret,
  putAppStoreConnectApiKeySecret,
  type AppleCertificateSecretData,
  type AppleCertificateType,
  type AppleProvisioningProfileSecretData,
  type AppStoreConnectApiKeySecretData,
  type LimrunSecretStoreOptions,
  type SigningSecret,
  type SigningSecretData,
  type SigningSecretMetadata,
  type SigningSecretStore,
  type SigningSecretType,
} from '../core/device-install/storage/secret-store';
export { normalizeCertificateSerial } from '../core/device-install/storage/browser-storage';

/**
 * Conventional secret name of a team's certificate bundle. One bundle per
 * team and Apple certificate type; the type is in the name so development
 * and distribution material never collide.
 */
export function appleCertificateSecretName(teamId: string, certificateType: AppleCertificateType) {
  return `${teamId}/${certificateType}`;
}

export type EnsureAppleCertificateInput = {
  relay: AppleRelayWebSocketClient;
  teamId: string;
  secretStore: SigningSecretStore;
  /**
   * Which portal certificate kind to ensure. Ad-hoc and App Store signing
   * both use the distribution certificate. Defaults to development.
   */
  certificateKind?: AppleCertificateKind;
  /** Common name used when minting a new certificate. */
  commonName?: string;
  log?: (message: string, detail?: string) => void;
};

export type EnsureAppleCertificateResult = {
  secret: SigningSecret;
  certificateId: string;
  /** True when a new certificate was minted instead of reusing the stored one. */
  created: boolean;
};

/**
 * Returns a usable certificate secret of the requested kind for the team,
 * reusing the stored one when its certificate is still on the team and
 * minting a new one otherwise. Apple caps certificates per kind (2 for
 * development, 3 for distribution) and never returns private keys, so
 * reuse of the stored p12 is strongly preferred.
 *
 * Durability of the stored material is the secret store's concern:
 * implementors who want retries or fallbacks build them into their
 * SigningSecretStore.
 */
export async function ensureAppleCertificateSecret({
  relay,
  teamId,
  secretStore,
  certificateKind = 'development',
  commonName,
  log = () => {},
}: EnsureAppleCertificateInput): Promise<EnsureAppleCertificateResult> {
  // The portal kinds map onto Apple's App Store Connect certificate type
  // enum, which is what consumers of the stored secret filter on.
  const certificateType: AppleCertificateType =
    certificateKind === 'distribution' ? 'DISTRIBUTION' : 'DEVELOPMENT';
  const secretName = appleCertificateSecretName(teamId, certificateType);
  const current = await listAppleCertificates({ relay, teamId, certificateKind });
  const findOnTeam = (certificateId: string | undefined) =>
    certificateId === undefined ? undefined : (
      current.find(
        (item) =>
          stringField(item, 'certificateId') === certificateId ||
          stringField(item, 'certRequestId') === certificateId,
      )
    );

  const stored = await secretStore.get(APPLE_CERTIFICATE_SECRET_TYPE, secretName);
  const storedCertificateId = stringField(stored?.data, 'certificateID');
  if (stored && storedCertificateId && stored.data.certificateP12Base64) {
    // The stored value may be a certRequestId; resolve the canonical
    // certificateId the profile API expects. If the cert is no longer on
    // the team (revoked), fall through and mint a new one.
    const matched = findOnTeam(storedCertificateId);
    if (matched) {
      const certificateId = stringField(matched, 'certificateId') ?? storedCertificateId;
      log('Reusing stored Apple certificate', certificateId);
      return { secret: stored, certificateId, created: false };
    }
    log('Stored certificate is no longer on the team', 'Minting a new one.');
  }

  // The private key is generated and kept in this browser; Apple only ever
  // sees the CSR. Without this key the downloaded cert cannot sign anything.
  const key = await generateAppleSigningKeyAndCSR({ commonName: commonName ?? `Limrun ${teamId}` });
  const certificate = await createAppleCertificate({
    relay,
    teamId,
    certificateKind,
    csrPEM: key.csrPEM,
  });
  const certificateId =
    stringField(certificate, 'certificateId') ?? stringField(certificate, 'certRequestId');
  if (!certificateId) {
    throw new Error('Apple certificate creation did not return a certificate ID.');
  }
  const downloaded = await downloadAppleCertificate({
    relay,
    teamId,
    certificateKind,
    certificateId,
  });
  if (!downloaded.rawBodyBase64) {
    throw new Error('Apple certificate download returned no bytes.');
  }
  const data: AppleCertificateSecretData = {
    certificateP12Base64: exportAppleCertificateP12({
      privateKeyPKCS8Base64: key.privateKeyPKCS8Base64,
      certificateBase64: downloaded.rawBodyBase64,
      password: '',
      friendlyName: `Apple ${certificateKind === 'distribution' ? 'Distribution' : 'Development'} ${teamId}`,
    }),
    certificateType,
    teamID: teamId,
    certificateID: certificateId,
    // Normalized so it equals the serials profiles reference.
    serialNumber: normalizeCertificateSerial(stringField(certificate, 'serialNum')),
    expirationDate: stringField(certificate, 'expirationDateString'),
  };

  let secret: SigningSecret;
  try {
    secret = await putAppleCertificateSecret(secretStore, secretName, data);
  } catch (error) {
    // The key existed only in this browser's memory; once this throw
    // unwinds it is gone, and the portal certificate is unusable.
    throw new Error(
      `Certificate ${certificateId} was created on the Apple Developer portal but saving its private ` +
        `key to the secret store failed: ${errorText(error)}. The key cannot be recovered; revoke ` +
        `certificate ${certificateId} at developer.apple.com before retrying, or the retry will mint ` +
        `another certificate against Apple's limit.`,
    );
  }
  log('Apple certificate stored', certificateId);
  return { secret, certificateId, created: true };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type SaveAppleProfileInput = {
  relay: AppleRelayWebSocketClient;
  teamId: string;
  profileId: string;
  secretStore: SigningSecretStore;
  log?: (message: string, detail?: string) => void;
};

/**
 * Downloads the provisioning profile and stores it as an
 * appleProvisioningProfile secret named `${teamId}/${uuid}`. The UUID is
 * unique per profile, so a team can hold many profiles for the same
 * bundle ID and certificate set; the reference fields (certificate
 * serials, bundle IDs, device IDs parsed out of the profile) are what
 * consumers filter on.
 */
export async function saveAppleProfileSecret({
  relay,
  teamId,
  profileId,
  secretStore,
  log = () => {},
}: SaveAppleProfileInput): Promise<SigningSecret> {
  const downloaded = await downloadAppleProfile({ relay, teamId, profileId });
  const profileBase64 = downloaded.rawBodyBase64;
  if (!profileBase64) {
    throw new Error('Apple provisioning profile download returned no bytes.');
  }
  const info = parseProvisioningProfileBase64(profileBase64);
  const name = `${teamId}/${info.uuid ?? profileId}`;
  const secret = await putAppleProvisioningProfileSecret(secretStore, name, {
    provisioningProfileBase64: profileBase64,
    certificateSerialNumbers: info.certificateSerialNumbers.join(','),
    bundleIDs: info.bundleID,
    deviceIDs: info.provisionedDevices.join(','),
    teamID: info.teamID ?? teamId,
    profileName: info.name,
    uuid: info.uuid,
    expirationDate: info.expirationDate,
  });
  log('Apple provisioning profile stored', name);
  return secret;
}

/**
 * Conventional secret name of a team's App Store Connect API key: one
 * shared key per team.
 */
export function appStoreConnectApiKeySecretName(teamId: string) {
  return `${teamId}/APP_STORE_CONNECT_API_KEY`;
}

export type EnsureAppStoreConnectApiKeyInput = {
  relay: AppleRelayWebSocketClient;
  teamId: string;
  /**
   * Numeric provider ID of the team from the Apple team list. When given,
   * the App Store Connect session is switched to this provider first;
   * required for accounts that belong to multiple teams.
   */
  providerId?: string | number;
  secretStore: SigningSecretStore;
  /** Display name for a newly minted key. Required; there is no default. */
  nickname: string;
  /** Roles of a newly minted key. Defaults to APP_MANAGER. */
  roles?: AppStoreConnectApiKeyRole[];
  log?: (message: string, detail?: string) => void;
};

export type EnsureAppStoreConnectApiKeyResult = {
  secret: SigningSecret;
  keyId: string;
  /** True when a new key was minted instead of reusing the stored one. */
  created: boolean;
};

/**
 * Returns a usable App Store Connect API key secret for the team, reusing
 * the stored one when its key is still active and minting a new one
 * otherwise. Apple serves a key's private half exactly once (at creation
 * time through the sparse fieldset download), so reuse of the stored .p8
 * is strongly preferred.
 *
 * The session user must be a team Admin to list or create keys.
 */
export async function ensureAppStoreConnectApiKeySecret({
  relay,
  teamId,
  providerId,
  secretStore,
  nickname,
  roles,
  log = () => {},
}: EnsureAppStoreConnectApiKeyInput): Promise<EnsureAppStoreConnectApiKeyResult> {
  if (!nickname) {
    throw new Error('A nickname is required to ensure an App Store Connect API key.');
  }
  if (providerId !== undefined) {
    await switchAppStoreConnectProvider({ relay, providerId });
  }
  const secretName = appStoreConnectApiKeySecretName(teamId);
  // Listing also primes the session's CSRF context, which Apple requires
  // on the creation POST below.
  const current = await listAppStoreConnectApiKeys({ relay });

  const stored = await secretStore.get(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, secretName);
  const storedKeyId = stringField(stored?.data, 'keyId');
  if (stored && storedKeyId && stored.data.privateKeyP8Base64) {
    const matched = current.find((item) => item.id === storedKeyId && !keyRevoked(item.attributes));
    if (matched) {
      // A team key without its issuer ID signs JWTs Apple rejects with
      // 401 NOT_AUTHORIZED; backfill it from the session before reuse.
      if (!stringField(stored.data, 'issuerId')) {
        const issuerId = await fetchAppStoreConnectIssuerId(relay);
        if (issuerId) {
          const repaired = await putAppStoreConnectApiKeySecret(secretStore, secretName, {
            ...(stored.data as AppStoreConnectApiKeySecretData),
            issuerId,
          });
          log('Backfilled the App Store Connect API key issuer ID', issuerId);
          return { secret: repaired, keyId: storedKeyId, created: false };
        }
      }
      log('Reusing stored App Store Connect API key', storedKeyId);
      return { secret: stored, keyId: storedKeyId, created: false };
    }
    log('Stored App Store Connect API key is no longer active', 'Minting a new one.');
  }

  const created = await createAppStoreConnectApiKey({ relay, nickname, roles });
  const keyId = created.id!;
  const downloaded = await downloadAppStoreConnectApiKeyPrivateKey({ relay, keyId });
  const data: AppStoreConnectApiKeySecretData = {
    privateKeyP8Base64: base64FromText(downloaded.privateKeyPem),
    keyId,
    issuerId: downloaded.issuerId,
    nickname,
    teamID: teamId,
  };

  let secret: SigningSecret;
  try {
    secret = await putAppStoreConnectApiKeySecret(secretStore, secretName, data);
  } catch (error) {
    // Apple never serves the private key again; once this throw unwinds
    // the downloaded copy is gone and the portal key is unusable.
    throw new Error(
      `App Store Connect API key ${keyId} was created but saving its private key to the secret ` +
        `store failed: ${errorText(error)}. The key cannot be downloaded again; revoke key ` +
        `${keyId} in App Store Connect before retrying, or the retry will mint another key.`,
    );
  }
  log('App Store Connect API key stored', keyId);
  return { secret, keyId, created: true };
}

function keyRevoked(attributes: Record<string, unknown> | undefined) {
  if (!attributes) return false;
  if (attributes.isActive === false) return true;
  const revokingDate = attributes.revokingDate ?? attributes.revocationDate;
  return typeof revokingDate === 'string' && revokingDate !== '';
}

function base64FromText(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export type ListTeamProfilesInput = {
  relay: AppleRelayWebSocketClient;
  teamId: string;
  /**
   * Which portal profile listing to use. The development listing is
   * unfiltered on the portal side and returns profiles of every
   * distribution method; adhoc narrows to ad-hoc profiles. Defaults to
   * development.
   */
  profileKind?: AppleProfileKind;
};

/** Lists the team's provisioning profiles from the portal. */
export async function listTeamAppleProfiles({
  relay,
  teamId,
  profileKind = 'development',
}: ListTeamProfilesInput) {
  return listAppleProfiles({ relay, teamId, profileKind });
}

/** Read a string-ish value from a loosely typed portal record. */
export function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
