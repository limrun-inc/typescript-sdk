/**
 * Headless helpers that turn an authenticated Apple relay session into
 * signing credentials persisted in a SigningSecretStore. The Apple relay
 * only proxies: certificate and profile bytes always land in the browser
 * first, and the browser writes them into the configured store (Limrun's
 * org secret store by default, or a customer-provided one).
 */
import {
  createAppleCertificate,
  downloadAppleCertificate,
  downloadAppleProfile,
  exportAppleCertificateP12,
  generateAppleSigningKeyAndCSR,
  listAppleCertificates,
  listAppleProfiles,
  type AppleCertificateKind,
  type AppleProfileKind,
} from '../app-store-relay';
import type { AppleRelayWebSocketClient } from '../core/device-install/apple';
import {
  normalizeCertificateSerial,
  parseProvisioningProfileBase64,
} from '../core/device-install/storage/browser-storage';
import {
  APPLE_CERTIFICATE_SECRET_TYPE,
  putAppleCertificateSecret,
  putAppleProvisioningProfileSecret,
  type AppleCertificateSecretData,
  type AppleCertificateType,
  type SigningSecret,
  type SigningSecretStore,
} from '../core/device-install/storage/secret-store';

export {
  APPLE_CERTIFICATE_SECRET_TYPE,
  APPLE_PROVISIONING_PROFILE_SECRET_TYPE,
  createBrowserSecretStore,
  createLimrunSecretStore,
  putAppleCertificateSecret,
  putAppleProvisioningProfileSecret,
  type AppleCertificateSecretData,
  type AppleCertificateType,
  type AppleProvisioningProfileSecretData,
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
