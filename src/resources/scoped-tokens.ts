// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class ScopedTokens extends APIResource {
  /**
   * Mint a short-lived scoped token whose scopes limit what the holder can do, e.g.
   * install a specific asset on a device through the registry. The token is verified
   * offline by services holding the token signing public key and cannot be revoked,
   * so keep TTLs short. It is bound to the authenticated caller's organization.
   */
  create(body: ScopedTokenCreateParams, options?: RequestOptions): APIPromise<ScopedToken> {
    return this._client.post('/v1/scoped_tokens', { body, ...options });
  }
}

export interface ScopedToken {
  /**
   * The scoped token, to be sent as a Bearer token or the token query parameter.
   */
  token: string;

  expiresAt: string;

  scopes: Array<string>;
}

export interface ScopedTokenCreateParams {
  /**
   * Scopes in the form <resource>:<id|_>:<action>, e.g. "device:_:install",
   * "asset:asset_01h455vb4pex5vsknk084sn02q:read" or "applerelay:\*:connect".
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
