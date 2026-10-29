import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class AccessTokens extends APIResource {
  /** Mint a temporary credential whose permissions are covered by the caller. */
  create(body: AccessTokenCreateParams, options?: RequestOptions): APIPromise<AccessToken> {
    return this._client.post('/v1/access_tokens', { body, ...options });
  }

  /** Revoke a credential by the ID returned when it was minted. */
  revoke(id: string, options?: RequestOptions): APIPromise<AccessTokenRevokeResponse> {
    return this._client.delete(`/v1/access_tokens/${encodeURIComponent(id)}`, options);
  }
}

export interface AccessToken {
  id: string;
  token: string;
  permissions: Array<string>;
  /** @deprecated Use permissions. */
  scopes: Array<string>;
  expiresAt: string;
}

export interface AccessTokenCreateParams {
  /**
   * Permissions in the form `<resource>:<id|*>:<action>`, e.g. `device:*:install`,
   * `asset:asset_01h455vb4pex5vsknk084sn02q:read` or `applerelay:*:connect`.
   * Resource IDs are the customer-visible IDs returned by the API.
   */
  permissions?: Array<string>;

  /** @deprecated Use permissions. If both are supplied, their permission sets must match. */
  scopes?: Array<string>;

  /**
   * How long the token stays valid. Defaults to 3600 (1 hour), maximum is 14400 (4
   * hours).
   */
  ttlSeconds?: number;
}

export interface AccessTokenRevokeResponse {
  status: string;
}

export declare namespace AccessTokens {
  export {
    type AccessToken as AccessToken,
    type AccessTokenCreateParams as AccessTokenCreateParams,
    type AccessTokenRevokeResponse,
  };
}
