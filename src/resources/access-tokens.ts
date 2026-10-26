import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import type { ScopedTokenCreateParams } from './scoped-tokens';

export class AccessTokens extends APIResource {
  /** Mint a temporary credential whose permissions are covered by the caller. */
  create(body: AccessTokenCreateParams, options?: RequestOptions): APIPromise<AccessToken> {
    return this._client.post('/v1/access_tokens', { body, ...options });
  }

  /** Revoke a credential by the ID returned when it was minted. */
  revoke(id: string, options?: RequestOptions): APIPromise<{ status: string }> {
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

export interface AccessTokenCreateParams extends ScopedTokenCreateParams {}

export declare namespace AccessTokens {
  export { type AccessToken as AccessToken, type AccessTokenCreateParams as AccessTokenCreateParams };
}
