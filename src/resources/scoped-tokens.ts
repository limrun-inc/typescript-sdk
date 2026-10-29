// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import type { AccessTokenCreateParams } from './access-tokens';
import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class ScopedTokens extends APIResource {
  /**
   * Mint a short-lived scoped token whose permissions limit what the holder can do, e.g.
   * install a specific asset on a device through the registry. The token is verified
   * by services holding the signing public key. It is bound to the caller's organization.
   * Prefer accessTokens.create for new code.
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

  /** Permissions granted to this credential. */
  permissions?: Array<string>;

  /** @deprecated Use permissions. */
  scopes: Array<string>;
}

/** @deprecated Use AccessTokenCreateParams. */
export type ScopedTokenCreateParams = AccessTokenCreateParams;

export declare namespace ScopedTokens {
  export { type ScopedToken as ScopedToken, type ScopedTokenCreateParams as ScopedTokenCreateParams };
}
