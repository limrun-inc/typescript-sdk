// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

/** @deprecated Use AccessTokens. */
export class ScopedTokens extends APIResource {
  /** @deprecated Use client.accessTokens.create(). This method keeps the legacy URL. */
  create(body: ScopedTokenCreateParams, options?: RequestOptions): APIPromise<ScopedToken> {
    return this._client.post('/v1/scoped_tokens', { body, ...options });
  }
}

/** @deprecated Use AccessToken. */
export interface ScopedToken {
  /** The revocation ID returned by current servers. */
  id?: string;
  /**
   * The scoped token, to be sent as a Bearer token or the token query parameter.
   */
  token: string;

  expiresAt: string;

  scopes: Array<string>;
}

/** @deprecated Use AccessTokenCreateParams. */
export interface ScopedTokenCreateParams {
  /**
   * Scopes in the form `<resource>:<id|*>:<action>`, e.g. `device:*:install`,
   * `asset:asset_01h455vb4pex5vsknk084sn02q:read` or `applerelay:*:connect`.
   * Resource IDs are the customer-visible IDs returned by the API.
   */
  scopes: Array<string>;

  /**
   * How long the token stays valid. Defaults to 3600 (1 hour), maximum is 14400 (4
   * hours).
   */
  ttlSeconds?: number;
}

export declare namespace ScopedTokens {
  export { type ScopedToken as ScopedToken, type ScopedTokenCreateParams as ScopedTokenCreateParams };
}
