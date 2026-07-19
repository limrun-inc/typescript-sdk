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
  createBrowserSecretStore,
  putAppleCertificateSecret,
  putAppleProvisioningProfileSecret,
  type AppleCertificateSecretData,
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

export type AppleCredentialProgressStep =
  | 'checkingExisting'
  | 'recoveringSavedKey'
  | 'generatingKey'
  | 'creatingCertificate'
  | 'downloadingCertificate'
  | 'storingSecret'
  | 'stored';

export type AppleCredentialProgress = {
  step: AppleCredentialProgressStep;
  /** Set while retrying the secret-store write. */
  attempt?: number;
  attempts?: number;
};

export type EnsureAppleCertificateInput = {
  relay: AppleRelayWebSocketClient;
  teamId: string;
  secretStore: SigningSecretStore;
  /** Common name used when minting a new certificate. */
  commonName?: string;
  /**
   * Where the freshly exported p12 is parked before (and while) the write
   * to secretStore is retried, so a failed write can never lose the only
   * copy of the private key. Defaults to this browser's IndexedDB; pass
   * undefined-returning stub only in non-browser environments.
   */
  localFallbackStore?: SigningSecretStore;
  /** Number of attempts for the secret-store write. */
  storeAttempts?: number;
  log?: (message: string, detail?: string) => void;
  onProgress?: (progress: AppleCredentialProgress) => void;
};

export type EnsureAppleCertificateResult = {
  secret: SigningSecret;
  certificateId: string;
  /** True when a new certificate was minted instead of reusing the stored one. */
  created: boolean;
  /** True when the p12 was recovered from the local fallback of a previously failed store write. */
  recovered: boolean;
};

function defaultLocalFallbackStore(): SigningSecretStore | undefined {
  // Non-browser callers (tests, SSR) have no IndexedDB; they must inject a
  // fallback store explicitly to get the parking behavior.
  return typeof indexedDB === 'undefined' ? undefined : createBrowserSecretStore();
}

/**
 * Returns a usable development certificate secret for the team, reusing the
 * stored one when its certificate is still on the team and minting a new
 * one otherwise. Apple caps development certificates at 2 and never returns
 * private keys, so reuse of the stored p12 is strongly preferred.
 *
 * Minting a certificate is an irreversible portal mutation, so the flow is
 * built to never lose the private key afterwards: the exported p12 is
 * parked in the local fallback store before the org-store write, the write
 * is retried with backoff, and a later call recovers a parked key (as long
 * as its certificate is still on the team) instead of minting again.
 */
export async function ensureAppleCertificateSecret({
  relay,
  teamId,
  secretStore,
  commonName,
  localFallbackStore = defaultLocalFallbackStore(),
  storeAttempts = 5,
  log = () => {},
  onProgress = () => {},
}: EnsureAppleCertificateInput): Promise<EnsureAppleCertificateResult> {
  onProgress({ step: 'checkingExisting' });
  const current = await listAppleCertificates({ relay, teamId, certificateKind: 'development' });
  const findOnTeam = (certificateId: string | undefined) =>
    certificateId === undefined ? undefined : (
      current.find(
        (item) =>
          stringField(item, 'certificateId') === certificateId ||
          stringField(item, 'certRequestId') === certificateId,
      )
    );

  const stored = await secretStore.get(APPLE_CERTIFICATE_SECRET_TYPE, teamId);
  if (stored?.data.certificateID && stored.data.certificateP12Base64) {
    // The stored value may be a certRequestId; resolve the canonical
    // certificateId the profile API expects. If the cert is no longer on
    // the team (revoked), fall through and mint a new one.
    const matched = findOnTeam(stored.data.certificateID);
    if (matched) {
      const certificateId = stringField(matched, 'certificateId') ?? stored.data.certificateID;
      log('Reusing stored Apple certificate', certificateId);
      return { secret: stored, certificateId, created: false, recovered: false };
    }
    log('Stored certificate is no longer on the team', 'Minting a new one.');
  }

  const storeWithRetries = async (data: AppleCertificateSecretData) => {
    return withRetries(() => putAppleCertificateSecret(secretStore, teamId, data), {
      attempts: storeAttempts,
      onAttempt: (attempt, error) => {
        onProgress({ step: 'storingSecret', attempt, attempts: storeAttempts });
        if (error) log('Retrying secret store write', errorText(error));
      },
    });
  };

  // A previous run may have minted a certificate and failed the org-store
  // write; its p12 is parked locally. Promote it instead of minting again,
  // which would burn another slot of Apple's two-certificate cap.
  const parked = await localFallbackStore?.get(APPLE_CERTIFICATE_SECRET_TYPE, teamId);
  if (parked?.data.certificateID && parked.data.certificateP12Base64) {
    const matched = findOnTeam(parked.data.certificateID);
    if (matched) {
      onProgress({ step: 'recoveringSavedKey' });
      const certificateId = stringField(matched, 'certificateId') ?? parked.data.certificateID;
      log('Recovering certificate key from this browser', certificateId);
      const secret = await storeWithRetries({
        ...(parked.data as AppleCertificateSecretData),
        certificateID: certificateId,
      });
      await localFallbackStore?.delete(APPLE_CERTIFICATE_SECRET_TYPE, teamId).catch(() => undefined);
      onProgress({ step: 'stored' });
      return { secret, certificateId, created: false, recovered: true };
    }
    // The parked certificate was revoked on the portal; the key is useless.
    await localFallbackStore?.delete(APPLE_CERTIFICATE_SECRET_TYPE, teamId).catch(() => undefined);
  }

  // The private key is generated and kept in this browser; Apple only ever
  // sees the CSR. Without this key the downloaded cert cannot sign anything.
  onProgress({ step: 'generatingKey' });
  const key = await generateAppleSigningKeyAndCSR({ commonName: commonName ?? `Limrun ${teamId}` });
  onProgress({ step: 'creatingCertificate' });
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
  onProgress({ step: 'downloadingCertificate' });
  // From here on the portal mutation already happened; download is a read
  // and safe to retry so a transient relay hiccup cannot orphan the key.
  const downloaded = await withRetries(
    async () => {
      const response = await downloadAppleCertificate({
        relay,
        teamId,
        certificateKind: 'development',
        certificateId,
      });
      if (!response.rawBodyBase64) {
        throw new Error('Apple certificate download returned no bytes.');
      }
      return response;
    },
    { attempts: 3 },
  );
  const data: AppleCertificateSecretData = {
    certificateP12Base64: exportAppleCertificateP12({
      privateKeyPKCS8Base64: key.privateKeyPKCS8Base64,
      certificateBase64: downloaded.rawBodyBase64,
      password: '',
      friendlyName: `Apple Development ${teamId}`,
    }),
    teamID: teamId,
    certificateID: certificateId,
    serialNumber: stringField(certificate, 'serialNum'),
    expirationDate: stringField(certificate, 'expirationDateString'),
  };

  // Park the p12 locally before attempting the org-store write: the local
  // put is the durability floor that makes a failed (or interrupted) write
  // recoverable without minting another certificate.
  await putAppleCertificateSecret(localFallbackStore ?? noopStore, teamId, data).catch((error) =>
    log('Could not park certificate key locally', errorText(error)),
  );

  onProgress({ step: 'storingSecret', attempt: 1, attempts: storeAttempts });
  let secret: SigningSecret;
  try {
    secret = await storeWithRetries(data);
  } catch (error) {
    throw new Error(
      `Certificate ${certificateId} was created on the Apple Developer portal but saving it to the ` +
        `secret store failed: ${errorText(error)}. The private key is kept safely in this browser; ` +
        `retry to save it without creating another certificate.`,
    );
  }
  await localFallbackStore?.delete(APPLE_CERTIFICATE_SECRET_TYPE, teamId).catch(() => undefined);
  log('Apple certificate stored', certificateId);
  onProgress({ step: 'stored' });
  return { secret, certificateId, created: true, recovered: false };
}

export type WithRetriesOptions = {
  attempts?: number;
  initialDelayMs?: number;
  onAttempt?: (attempt: number, previousError?: unknown) => void;
};

/** Runs fn with exponential backoff between attempts. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  { attempts = 5, initialDelayMs = 1000, onAttempt }: WithRetriesOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, initialDelayMs * 2 ** (attempt - 2)));
    }
    onAttempt?.(attempt, lastError);
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Sink for the local parking write when no fallback store is available. */
const noopStore: SigningSecretStore = {
  put: async (type, name, data) => ({ type, name, data }),
  get: async () => undefined,
  list: async () => [],
  delete: async () => {},
};

export type SaveAppleProfileInput = {
  relay: AppleRelayWebSocketClient;
  teamId: string;
  profileId: string;
  secretStore: SigningSecretStore;
  /** Number of attempts for the secret-store write. */
  storeAttempts?: number;
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
  storeAttempts = 5,
  log = () => {},
}: SaveAppleProfileInput): Promise<SigningSecret> {
  const downloaded = await downloadAppleProfile({ relay, teamId, profileId });
  const profileBase64 = downloaded.rawBodyBase64;
  if (!profileBase64) {
    throw new Error('Apple provisioning profile download returned no bytes.');
  }
  const info = parseProvisioningProfileBase64(profileBase64);
  const name = `${teamId}/${info.bundleID ?? info.uuid ?? profileId}`;
  // Unlike certificates, a failed profile write loses nothing (the profile
  // can always be re-downloaded), but retrying keeps the whole save flow
  // resilient to transient store errors.
  const secret = await withRetries(
    () =>
      putAppleProvisioningProfileSecret(secretStore, name, {
        provisioningProfileBase64: profileBase64,
        teamID: info.teamID ?? teamId,
        bundleID: info.bundleID,
        profileName: info.name,
        uuid: info.uuid,
        expirationDate: info.expirationDate,
      }),
    {
      attempts: storeAttempts,
      onAttempt: (_attempt, error) => {
        if (error) log('Retrying profile secret write', errorText(error));
      },
    },
  );
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
