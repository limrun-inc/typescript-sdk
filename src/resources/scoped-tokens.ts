// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import {
  type AccessTokenCreateParams,
  TOKEN_SERVICE_URL,
  tokenServiceBody,
  withScopes,
} from './access-tokens';
import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

/** @deprecated Use AccessTokens. */
export class ScopedTokens extends APIResource {
  /**
   * Mint a short-lived access token whose permissions limit what the holder can do, e.g.
   * install a specific asset on a device through the registry. The token is verified
   * by services holding the signing public key. It is bound to the caller's organization.
   * @deprecated Use client.accessTokens.create(), which this method now calls through to.
   */
  create(body: ScopedTokenCreateParams, options?: RequestOptions): APIPromise<ScopedToken> {
    return this._client
      .post<ScopedToken & { permissions: Array<string> }>('/v1/access_tokens', {
        body: tokenServiceBody(body),
        defaultBaseURL: TOKEN_SERVICE_URL,
        ...options,
      })
      ._thenUnwrap(withScopes);
  }
}

/** @deprecated Use AccessToken. */
export interface ScopedToken {
  /** Credential ID, when returned by the server. */
  id?: string;

  /**
   * The access token, to be sent in the Authorization Bearer header.
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
