/**
 * A pluggable store for Apple signing secrets.
 *
 * Credential material always lands in the browser first (the Apple relay
 * only proxies); the browser then writes it into a store implementing this
 * interface. Limrun's org secret store is the default implementation, an
 * IndexedDB-backed one keeps everything local, and customers can bring
 * their own store by implementing the same interface.
 */

export const APPLE_CERTIFICATE_SECRET_TYPE = 'appleCertificate';
export const APPLE_PROVISIONING_PROFILE_SECRET_TYPE = 'appleProvisioningProfile';

export type SigningSecretType =
  | typeof APPLE_CERTIFICATE_SECRET_TYPE
  | typeof APPLE_PROVISIONING_PROFILE_SECRET_TYPE;

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
 * Data payload of an appleProvisioningProfile secret. The
 * certificateSerialNumbers, bundleIDs and deviceIDs fields duplicate what
 * the signed profile binds (as comma-separated lists) so profiles can be
 * filtered by certificate, bundle ID or device without parsing every
 * entry. Certificates are referenced by serial number, the identifier
 * Apple embeds in the profile itself.
 */
export type AppleProvisioningProfileSecretData = {
  provisioningProfileBase64: string;
  certificateSerialNumbers?: string;
  bundleIDs?: string;
  deviceIDs?: string;
  teamID?: string;
  profileName?: string;
  uuid?: string;
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

export type LimrunSecretStoreOptions = {
  /** Base URL of the Limrun backend API, e.g. https://api.limrun.com */
  apiUrl: string;
  /** Bearer token: a user or organization token. */
  token: string;
  /** Organization TID owning the secrets. */
  organizationId: string;
  /** Custom fetch, mainly for tests. */
  fetch?: typeof fetch;
};

type BackendSecretResult = {
  id: string;
  type: string;
  name: string;
  organizationId: string;
  data: SigningSecretData;
  createdAt: string;
};

/**
 * A SigningSecretStore backed by Limrun's organization secret store
 * (`/v1/organizations/{org}/secrets`). Secrets are stored server-side and
 * shared across the organization.
 */
export function createLimrunSecretStore(options: LimrunSecretStoreOptions): SigningSecretStore {
  const doFetch = options.fetch ?? fetch.bind(globalThis);
  const base = options.apiUrl.replace(/\/+$/, '');
  const secretUrl = (type: string, name: string) =>
    `${base}/v1/organizations/${encodeURIComponent(options.organizationId)}/secrets/${encodeURIComponent(
      type,
    )}/${encodeURIComponent(name)}`;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json',
  };

  async function fail(response: Response, action: string): Promise<never> {
    let message = `${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body; the status code is the best we have.
    }
    throw new Error(`Failed to ${action} secret: ${message}`);
  }

  return {
    async put(type, name, data) {
      const response = await doFetch(secretUrl(type, name), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ data, replace: true }),
      });
      if (!response.ok) await fail(response, 'store');
      const result = (await response.json()) as BackendSecretResult;
      return { type: result.type, name: result.name, createdAt: result.createdAt, data: result.data };
    },
    async get(type, name) {
      const response = await doFetch(secretUrl(type, name), { method: 'GET', headers });
      if (response.status === 404) return undefined;
      if (!response.ok) await fail(response, 'fetch');
      const result = (await response.json()) as BackendSecretResult;
      return { type: result.type, name: result.name, createdAt: result.createdAt, data: result.data };
    },
    async list() {
      const response = await doFetch(
        `${base}/v1/organizations/${encodeURIComponent(options.organizationId)}/secrets`,
        { method: 'GET', headers },
      );
      if (!response.ok) await fail(response, 'list');
      const result = (await response.json()) as Omit<BackendSecretResult, 'data'>[];
      return result
        .filter(
          (s) =>
            s.type === APPLE_CERTIFICATE_SECRET_TYPE || s.type === APPLE_PROVISIONING_PROFILE_SECRET_TYPE,
        )
        .map((s) => ({ type: s.type, name: s.name, createdAt: s.createdAt }));
    },
    async delete(type, name) {
      const response = await doFetch(secretUrl(type, name), { method: 'DELETE', headers });
      if (response.status === 404) return;
      if (!response.ok) await fail(response, 'delete');
    },
  };
}

const SECRETS_DB_NAME = 'limrun-signing-secrets';
const SECRETS_DB_VERSION = 1;
const SECRETS_STORE_NAME = 'secrets';

type BrowserStoredSecret = {
  id: string;
  type: string;
  name: string;
  data: SigningSecretData;
  createdAt: string;
};

/**
 * A SigningSecretStore keeping everything in the browser's IndexedDB.
 * Nothing leaves the machine; secrets are per-browser-profile.
 */
export function createBrowserSecretStore(): SigningSecretStore {
  const idOf = (type: string, name: string) => `${type}:${name}`;

  function open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SECRETS_DB_NAME, SECRETS_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SECRETS_STORE_NAME)) {
          db.createObjectStore(SECRETS_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Open IndexedDB failed'));
    });
  }

  function toPromise<T = unknown>(request: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  }

  return {
    async put(type, name, data) {
      const db = await open();
      const existing = await toPromise<BrowserStoredSecret | undefined>(
        db.transaction(SECRETS_STORE_NAME, 'readonly').objectStore(SECRETS_STORE_NAME).get(idOf(type, name)),
      );
      const stored: BrowserStoredSecret = {
        id: idOf(type, name),
        type,
        name,
        data,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      await toPromise(
        db.transaction(SECRETS_STORE_NAME, 'readwrite').objectStore(SECRETS_STORE_NAME).put(stored),
      );
      return { type, name, createdAt: stored.createdAt, data };
    },
    async get(type, name) {
      const db = await open();
      const stored = await toPromise<BrowserStoredSecret | undefined>(
        db.transaction(SECRETS_STORE_NAME, 'readonly').objectStore(SECRETS_STORE_NAME).get(idOf(type, name)),
      );
      if (!stored) return undefined;
      return { type: stored.type, name: stored.name, createdAt: stored.createdAt, data: stored.data };
    },
    async list() {
      const db = await open();
      const all = await toPromise<BrowserStoredSecret[]>(
        db.transaction(SECRETS_STORE_NAME, 'readonly').objectStore(SECRETS_STORE_NAME).getAll(),
      );
      return all.map((s) => ({ type: s.type, name: s.name, createdAt: s.createdAt }));
    },
    async delete(type, name) {
      const db = await open();
      await toPromise(
        db
          .transaction(SECRETS_STORE_NAME, 'readwrite')
          .objectStore(SECRETS_STORE_NAME)
          .delete(idOf(type, name)),
      );
    },
  };
}
