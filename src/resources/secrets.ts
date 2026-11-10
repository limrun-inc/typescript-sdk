import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { buildHeaders } from '../internal/headers';
import { getDefaultFetch } from '../internal/shims';

/** Descriptive data stored by Limrun. Never put credentials in metadata. */
export interface SecretMetadata {
  id: string;
  name: string;
  type: string;
  organizationId: string;
  metadata: Record<string, unknown>;
  storageLocation: 'us' | 'eu';
  state: 'pending' | 'ready' | 'deleting';
  createdAt: string;
}
export interface SecretCreateParams {
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
}
export interface SecretUpdateParams {
  /** Replaces descriptive metadata; does not change the name, type, or value. */
  metadata: Record<string, unknown>;
}
export interface SecretListParams {
  nameFilter?: string;
  limit?: number;
  offset?: number;
}
export interface SecretListResponse {
  secrets: SecretMetadata[];
}
export interface SecretAccessToken {
  accessToken: string;
  expiresAt: string;
  resource: string;
  action: 'read' | 'write';
}
export interface SecretRequestOptions extends RequestOptions {
  /** Defaults to the organization returned by whoami. */
  organizationId?: string;
}
export interface SecretValueOptions extends RequestOptions {
  /** Transport for direct Google requests, separate from the authenticated Limrun transport. */
  storageFetch?: typeof fetch;
}

const resourcePattern = /^projects\/[a-zA-Z0-9-]+\/secrets\/secret_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const maxBytes = 65536;

function checksum(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

export class Secrets extends APIResource {
  /** Create a container. Duplicate names return 409; values are written separately. */
  create(body: SecretCreateParams, options?: RequestOptions): APIPromise<SecretMetadata> {
    return this._client.post('/v1/secrets', { body, ...options });
  }

  /** Update descriptive metadata by TID or name/<exact name>, without accessing its value. */
  update(target: string, body: SecretUpdateParams, options?: RequestOptions): APIPromise<SecretMetadata> {
    return this._client.patch(`/v1/secrets/${encodeURIComponent(target)}`, { body, ...options });
  }

  private async collection(
    options: SecretRequestOptions = {},
  ): Promise<{ path: string; options: RequestOptions }> {
    const { organizationId, ...request } = options;
    let org = organizationId;
    if (!org) {
      const identity = await this._client.get<{
        organization?: { id?: string };
        user?: { defaultOrganization?: { id?: string } };
      }>('/v1/whoami', request);
      org = identity.organization?.id ?? identity.user?.defaultOrganization?.id;
    }
    if (!org) throw new Error('No organization found. Provide organizationId explicitly.');
    return { path: `/v1/organizations/${encodeURIComponent(org)}/secrets`, options: request };
  }

  /** List metadata visible to this credential. Values are never included. */
  async list(query: SecretListParams = {}, options?: SecretRequestOptions): Promise<SecretListResponse> {
    const collection = await this.collection(options);
    return this._client.get(collection.path, { ...collection.options, query });
  }

  /** Fetch metadata by TID or name/<exact name>. */
  async get(target: string, options?: SecretRequestOptions): Promise<SecretMetadata> {
    if (target.startsWith('name/')) {
      const result = await this.list({ nameFilter: target.slice(5), limit: 1 }, options);
      if (!result.secrets[0]) throw new Error('Secret not found.');
      return result.secrets[0];
    }
    const collection = await this.collection(options);
    return this._client.get(`${collection.path}/${encodeURIComponent(target)}`, collection.options);
  }

  /** Delete the container and all its versions. */
  async delete(target: string, options?: SecretRequestOptions): Promise<void> {
    const id = target.startsWith('name/') ? (await this.get(target, options)).id : target;
    const collection = await this.collection(options);
    await this._client.delete(`${collection.path}/${encodeURIComponent(id)}`, {
      ...collection.options,
      headers: buildHeaders([{ Accept: '*/*' }, collection.options.headers]),
    });
  }

  /** Mint access to one secret; no metadata-read permission is needed. */
  createAccessToken(
    target: string,
    action: 'read' | 'write',
    options?: RequestOptions,
  ): APIPromise<SecretAccessToken> {
    // Debug logging must not expose the provider bearer credential.
    return this._client.withOptions({ logLevel: 'off' }).post('/v1/secrets/access_tokens', {
      ...options,
      body: { target, action },
    });
  }

  private async transfer(
    target: string,
    action: 'read' | 'write',
    bytes: Uint8Array | undefined,
    options: SecretValueOptions = {},
  ): Promise<Response> {
    const { storageFetch = getDefaultFetch(), ...request } = options;
    const timeout = AbortSignal.timeout(options.timeout ?? this._client.timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const grant = await this.createAccessToken(target, action, { ...request, signal });
    if (
      grant.action !== action ||
      !resourcePattern.test(grant.resource) ||
      (!target.startsWith('name/') && !grant.resource.endsWith(`/${target}`))
    ) {
      throw new Error('Invalid secret access grant.');
    }
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await storageFetch(
        `https://secretmanager.googleapis.com/v1/${grant.resource}${
          action === 'read' ? '/versions/latest:access' : ':addVersion'
        }`,
        {
          method: action === 'read' ? 'GET' : 'POST',
          credentials: 'omit',
          ...{ cache: 'no-store', referrerPolicy: 'no-referrer' },
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${grant.accessToken}`,
            ...(bytes ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(bytes ?
            {
              body: JSON.stringify({
                payload: {
                  data: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')),
                  dataCrc32c: checksum(bytes),
                },
              }),
            }
          : {}),
        },
      );
    } catch {
      throw new Error(
        signal.aborted ? 'Secret storage request was aborted.' : 'Secret storage request failed.',
      );
    }
    // Provider error bodies may echo secret material. Never include them in errors or logs.
    if (!response.ok) throw new Error(`Secret storage request failed (HTTP ${response.status}).`);
    return response;
  }

  /** Read bytes directly from Google. Does not fetch or cache metadata. */
  async read(target: string, options?: SecretValueOptions): Promise<Uint8Array> {
    const response = await this.transfer(target, 'read', undefined, options);
    let value: { payload?: { data?: string; dataCrc32c?: string } };
    let bytes: Uint8Array;
    try {
      value = (await response.json()) as typeof value;
      if (typeof value.payload?.data !== 'string' || value.payload.data.length > Math.ceil(maxBytes / 3) * 4)
        throw new Error();
      bytes = Uint8Array.from(atob(value.payload.data), (c) => c.charCodeAt(0));
    } catch {
      throw new Error('Secret storage returned an invalid value.');
    }
    if (bytes.length > maxBytes || checksum(bytes) !== String(value.payload?.dataCrc32c))
      throw new Error('Secret integrity check failed.');
    return bytes;
  }

  /** Add a version directly in Google. Accepts UTF-8 text or binary data, up to 64 KiB. */
  async write(target: string, value: string | Uint8Array, options?: SecretValueOptions): Promise<void> {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (!bytes.length || bytes.length > maxBytes)
      throw new Error('Secret values must contain between 1 byte and 64 KiB.');
    await this.transfer(target, 'write', bytes, options);
  }
}
