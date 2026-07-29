import {
  ANDROID_SIGNING_KEY_SECRET_TYPE,
  type SigningSecretData,
  type SigningSecretStore,
} from './secret-store';

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
 * shared across the organization; keystores escrowed here are the ones
 * `lim gradle build --sign` picks up.
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
      // Older backends return a bare array; current ones a {secrets: [...]}
      // envelope. Accept both so a published package works against either.
      type ListedSecret = Omit<BackendSecretResult, 'data'>;
      const body = (await response.json()) as ListedSecret[] | { secrets: ListedSecret[] };
      const result = Array.isArray(body) ? body : body.secrets;
      return result
        .filter((s) => s.type === ANDROID_SIGNING_KEY_SECRET_TYPE)
        .map((s) => ({ type: s.type, name: s.name, createdAt: s.createdAt }));
    },
    async delete(type, name) {
      const response = await doFetch(secretUrl(type, name), { method: 'DELETE', headers });
      if (response.status === 404) return;
      if (!response.ok) await fail(response, 'delete');
    },
  };
}
