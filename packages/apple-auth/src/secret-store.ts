/**
 * A pluggable store for Apple signing secrets.
 *
 * Credential material always lands in the browser first (the Apple relay
 * only proxies); the browser then writes it into a store implementing this
 * interface. Limrun's org secret store (createLimrunSecretStore) is the
 * default implementation; customers can bring their own store, backed by
 * their own database or KMS, by implementing the same interface.
 */

export const APPLE_CERTIFICATE_SECRET_TYPE = 'appleCertificate';
export const APPLE_PROVISIONING_PROFILE_SECRET_TYPE = 'appleProvisioningProfile';
export const APP_STORE_CONNECT_API_KEY_SECRET_TYPE = 'appStoreConnectApiKey';
/** Android upload keystore; escrowed by the CLI's `lim gradle build --sign`. */
export const ANDROID_SIGNING_KEY_SECRET_TYPE = 'androidSigningKey';

// Mirrors the secret types Limrun's organization secrets API accepts; the
// Android upload keystore rides the same store as the Apple material.
export type SigningSecretType =
  | typeof APPLE_CERTIFICATE_SECRET_TYPE
  | typeof APPLE_PROVISIONING_PROFILE_SECRET_TYPE
  | typeof APP_STORE_CONNECT_API_KEY_SECRET_TYPE
  | typeof ANDROID_SIGNING_KEY_SECRET_TYPE;

export type SigningSecretMetadata = {
  type: string;
  name: string;
  createdAt?: string;
};

/** Type-specific flat key-value payload of a signing secret. */
export type SigningSecretData = Record<string, string>;

export type SigningSecret = SigningSecretMetadata & {
  data: SigningSecretData;
};

export interface SigningSecretStore {
  /**
   * Stores a secret. When a secret with the same type and name already
   * exists its data is overwritten. Returns the stored secret; callers
   * should use the returned data.
   */
  put(type: SigningSecretType, name: string, data: SigningSecretData): Promise<SigningSecret>;
  /** Returns the secret including its data, or undefined when absent. */
  get(type: SigningSecretType, name: string): Promise<SigningSecret | undefined>;
  /** Lists metadata of all stored signing secrets, never their data. */
  list(): Promise<SigningSecretMetadata[]>;
  /** Deletes a secret; resolves even when the secret does not exist. */
  delete(type: SigningSecretType, name: string): Promise<void>;
}

/**
 * Apple's certificate types as defined by the App Store Connect API
 * (https://developer.apple.com/documentation/appstoreconnectapi/certificatetype).
 */
export type AppleCertificateType =
  | 'DEVELOPMENT'
  | 'DISTRIBUTION'
  | 'IOS_DEVELOPMENT'
  | 'IOS_DISTRIBUTION'
  | 'MAC_APP_DEVELOPMENT'
  | 'MAC_APP_DISTRIBUTION'
  | 'MAC_INSTALLER_DISTRIBUTION'
  | 'DEVELOPER_ID_APPLICATION'
  | 'DEVELOPER_ID_INSTALLER'
  | 'DEVELOPER_ID_KEXT'
  | 'PASS_TYPE_ID'
  | 'PASS_TYPE_ID_WITH_NFC';

/** Data payload of an appleCertificate secret. */
export type AppleCertificateSecretData = {
  certificateP12Base64: string;
  /** Which of Apple's certificate types the p12 holds. */
  certificateType: AppleCertificateType;
  certificatePassword?: string;
  teamID?: string;
  /** Apple's portal certificate id, never a Limrun DB id. */
  certificateID?: string;
  /** The certificate's serial number: uppercase hex, no leading zeros. */
  serialNumber?: string;
  expirationDate?: string;
};

/**
 * A device a provisioning profile is bound to: the UDID the profile
 * embeds, enriched with the device's record on the Apple Developer portal
 * so users can recognize their devices without looking UDIDs up.
 */
export type ProvisionedDevice = {
  /** The device UDID, the identifier profiles bind. */
  udid: string;
  /** The device's name as registered on the Apple Developer portal. */
  name?: string;
  /** Apple's hardware model string, e.g. "iPhone 14 Pro". */
  model?: string;
};

/**
 * Data payload of an appleProvisioningProfile secret. The
 * certificateSerialNumbers, bundleIDs and deviceIDs fields duplicate what
 * the signed profile binds so profiles can be filtered by certificate,
 * bundle ID or device without parsing every entry. Certificates and
 * bundle IDs are comma-separated lists; deviceIDs is a JSON array of
 * ProvisionedDevice. Certificates are referenced by serial number, the
 * identifier Apple embeds in the profile itself.
 */
export type AppleProvisioningProfileSecretData = {
  provisioningProfileBase64: string;
  certificateSerialNumbers?: string;
  bundleIDs?: string;
  /** JSON array of ProvisionedDevice; absent for App Store profiles. */
  deviceIDs?: string;
  teamID?: string;
  profileName?: string;
  uuid?: string;
  expirationDate?: string;
};

/** Parses the deviceIDs field of an appleProvisioningProfile secret. */
export function parseProvisionedDevices(value: string | undefined): ProvisionedDevice[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is ProvisionedDevice =>
      !!item && typeof item === 'object' && typeof (item as { udid?: unknown }).udid === 'string',
  );
}

/**
 * Data payload of an appStoreConnectApiKey secret: the private half of an
 * App Store Connect API key plus the identifiers needed to sign JWTs with
 * it. Apple serves the private key exactly once, so the stored copy is the
 * only one.
 */
export type AppStoreConnectApiKeySecretData = {
  /** Base64 of the .p8 private key PEM. */
  privateKeyP8Base64: string;
  /** Apple's key ID, e.g. 2X9R4HXF34. */
  keyId: string;
  /** Issuer ID for team keys. Absent for individual keys. */
  issuerId?: string;
  /**
   * Vendor number of the team's legal entity, which the sales and finance
   * report endpoints require as filter[vendorNumber]. Absent when the
   * session user could not see Payments and Financial Reports.
   */
  vendorNumber?: string;
  /** Comma-separated roles the key was minted with, e.g. ADMIN. */
  roles?: string;
  nickname?: string;
  teamID?: string;
  expirationDate?: string;
};

function compactData(data: Record<string, string | undefined>): SigningSecretData {
  const result: SigningSecretData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value) result[key] = value;
  }
  return result;
}

/** Stores an Apple certificate bundle, conventionally named `${teamID}/${certificateType}`. */
export async function putAppleCertificateSecret(
  store: SigningSecretStore,
  name: string,
  data: AppleCertificateSecretData,
) {
  return store.put(APPLE_CERTIFICATE_SECRET_TYPE, name, compactData(data));
}

/**
 * Stores a provisioning profile, conventionally named `${teamID}/${uuid}`
 * so a team can hold many profiles for the same bundle ID and certificate
 * set; consumers select by the reference fields, not by name.
 */
export async function putAppleProvisioningProfileSecret(
  store: SigningSecretStore,
  name: string,
  data: AppleProvisioningProfileSecretData,
) {
  return store.put(APPLE_PROVISIONING_PROFILE_SECRET_TYPE, name, compactData(data));
}

/**
 * Stores an App Store Connect API key, conventionally named
 * `${teamID}/APP_STORE_CONNECT_API_KEY`: one shared key per team.
 */
export async function putAppStoreConnectApiKeySecret(
  store: SigningSecretStore,
  name: string,
  data: AppStoreConnectApiKeySecretData,
) {
  return store.put(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, name, compactData(data));
}
