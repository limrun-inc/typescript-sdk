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
} from '../app-store-relay';
import type { AppleRelayWebSocketClient } from '../core/device-install/apple';
import { parseProvisioningProfileBase64 } from '../core/device-install/storage/browser-storage';
import {
  APPLE_CERTIFICATE_SECRET_TYPE,
  putAppleCertificateSecret,
  putAppleProvisioningProfileSecret,
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
  type AppleProvisioningProfileSecretData,
  type LimrunSecretStoreOptions,
  type SigningSecret,
  type SigningSecretMetadata,
  type SigningSecretStore,
  type SigningSecretType,
} from '../core/device-install/storage/secret-store';

export type EnsureAppleCertificateInput = {
  relay: AppleRelayWebSocketClient;
  teamId: string;
  secretStore: SigningSecretStore;
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
 * Returns a usable development certificate secret for the team, reusing the
 * stored one when its certificate is still on the team and minting a new
 * one otherwise. Apple caps development certificates at 2 and never returns
 * private keys, so reuse of the stored p12 is strongly preferred.
 */
export async function ensureAppleCertificateSecret({
  relay,
  teamId,
  secretStore,
  commonName,
  log = () => {},
}: EnsureAppleCertificateInput): Promise<EnsureAppleCertificateResult> {
  const current = await listAppleCertificates({ relay, teamId, certificateKind: 'development' });
  const stored = await secretStore.get(APPLE_CERTIFICATE_SECRET_TYPE, teamId);
  const storedCertificateId = stored?.data.certificateID;
  if (stored && storedCertificateId && stored.data.certificateP12Base64) {
    // The stored value may be a certRequestId; resolve the canonical
    // certificateId the profile API expects. If the cert is no longer on
    // the team (revoked), fall through and mint a new one.
    const matched = current.find(
      (item) =>
        stringField(item, 'certificateId') === storedCertificateId ||
        stringField(item, 'certRequestId') === storedCertificateId,
    );
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
    certificateKind: 'development',
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
    certificateKind: 'development',
    certificateId,
  });
  if (!downloaded.rawBodyBase64) {
    throw new Error('Apple certificate download returned no bytes.');
  }
  const certificateP12Base64 = exportAppleCertificateP12({
    privateKeyPKCS8Base64: key.privateKeyPKCS8Base64,
    certificateBase64: downloaded.rawBodyBase64,
    password: '',
    friendlyName: `Apple Development ${teamId}`,
  });
  const listed = current.find(
    (item) =>
      stringField(item, 'certificateId') === certificateId ||
      stringField(item, 'certRequestId') === certificateId,
  );
  const secret = await putAppleCertificateSecret(secretStore, teamId, {
    certificateP12Base64,
    teamID: teamId,
    certificateID: certificateId,
    serialNumber: stringField(listed, 'serialNum') ?? stringField(certificate, 'serialNum'),
    expirationDate:
      stringField(listed, 'expirationDateString') ?? stringField(certificate, 'expirationDateString'),
  });
  log('Apple certificate stored', certificateId);
  return { secret, certificateId, created: true };
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
 * appleProvisioningProfile secret named `${teamId}/${bundleID}` (falling
 * back to the profile UUID when the bundle ID cannot be parsed).
 */
export async function saveAppleProfileSecret({
  relay,
  teamId,
  profileId,
  secretStore,
  log = () => {},
}: SaveAppleProfileInput): Promise<SigningSecret> {
  const downloaded = await downloadAppleProfile({ relay, teamId, profileId });
  if (!downloaded.rawBodyBase64) {
    throw new Error('Apple provisioning profile download returned no bytes.');
  }
  const info = parseProvisioningProfileBase64(downloaded.rawBodyBase64);
  const name = `${teamId}/${info.bundleID ?? info.uuid ?? profileId}`;
  const secret = await putAppleProvisioningProfileSecret(secretStore, name, {
    provisioningProfileBase64: downloaded.rawBodyBase64,
    teamID: info.teamID ?? teamId,
    bundleID: info.bundleID,
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
};

/** Lists the team's development provisioning profiles from the portal. */
export async function listTeamAppleProfiles({ relay, teamId }: ListTeamProfilesInput) {
  return listAppleProfiles({ relay, teamId, profileKind: 'development' });
}

/** Read a string-ish value from a loosely typed portal record. */
export function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
