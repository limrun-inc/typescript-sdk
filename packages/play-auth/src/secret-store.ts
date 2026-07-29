/**
 * A pluggable store for Android signing secrets, the Play twin of the
 * SigningSecretStore in @limrun/apple-auth (the two interfaces are
 * structurally identical, so one store instance can serve both packages).
 *
 * Upload keystores are born in the browser (generateAndroidUploadKeystore)
 * or imported by the user; either way they go only into a store
 * implementing this interface. Limrun's org secret store
 * (createLimrunSecretStore) is the default implementation; customers can
 * bring their own store, backed by their own database or KMS, by
 * implementing the same interface.
 */

import type { AndroidUploadKeystore } from './keystore';

/** Android upload keystore; the same type the CLI's `lim gradle build --sign` escrows. */
export const ANDROID_SIGNING_KEY_SECRET_TYPE = 'androidSigningKey';

export type SigningSecretType = typeof ANDROID_SIGNING_KEY_SECRET_TYPE;

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
 * Data payload of an androidSigningKey secret: a PKCS12 upload keystore
 * plus the passwords and alias needed to sign with it, exactly what
 * generateAndroidUploadKeystore returns. Google's Play App Signing
 * re-signs for distribution, so this key only ever signs uploads, but
 * losing or replacing it still breaks every later upload.
 */
export type AndroidSigningKeySecretData = AndroidUploadKeystore;

/**
 * Escrows an Android upload keystore. The lim CLI's `gradle build --sign`
 * stores keys in Limrun's org store under the bare application ID
 * (e.g. `com.example.app`); use that name when the store is shared with
 * CLI builds so both sign with the same key.
 */
export async function putAndroidSigningKeySecret(
  store: SigningSecretStore,
  name: string,
  data: AndroidSigningKeySecretData,
) {
  return store.put(ANDROID_SIGNING_KEY_SECRET_TYPE, name, data);
}
