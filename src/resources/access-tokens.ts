import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { LimrunError } from '../core/error';
import { RequestOptions } from '../internal/request-options';

/**
 * The Limrun token service mints and revokes access tokens. A client with its own `baseURL`
 * sends these requests to that URL instead.
 */
export const TOKEN_SERVICE_URL = 'https://sts.limrun.com';

export class AccessTokens extends APIResource {
  /** Mint a temporary credential whose permissions are covered by the caller. */
  create(body: AccessTokenCreateParams, options?: RequestOptions): APIPromise<AccessToken> {
    return this._client
      .post<AccessToken>('/v1/access_tokens', {
        body: tokenServiceBody(body),
        defaultBaseURL: TOKEN_SERVICE_URL,
        ...options,
      })
      ._thenUnwrap(withScopes);
  }

  /** Revoke a credential by the ID returned when it was minted. */
  revoke(id: string, options?: RequestOptions): APIPromise<AccessTokenRevokeResponse> {
    return this._client.delete(`/v1/access_tokens/${encodeURIComponent(id)}`, {
      defaultBaseURL: TOKEN_SERVICE_URL,
      ...options,
    });
  }
}

/**
 * The token service accepts only `permissions`, so the deprecated `scopes` alias is
 * resolved here, with the same rule the API applied: both must name the same set.
 */
export function tokenServiceBody({ scopes, ...body }: AccessTokenCreateParams): AccessTokenCreateParams {
  if (!scopes) return body;
  if (!body.permissions) return { ...body, permissions: scopes };
  const permissions = new Set(body.permissions);
  if (new Set(scopes).size !== permissions.size || scopes.some((scope) => !permissions.has(scope))) {
    throw new LimrunError('permissions and the deprecated scopes must name the same permissions');
  }
  return body;
}

/** Fills the deprecated `scopes` field, which the token service no longer returns. */
export function withScopes<T extends { permissions: Array<string>; scopes?: Array<string> }>(
  token: T,
): T & { scopes: Array<string> } {
  return { ...token, scopes: token.scopes ?? token.permissions };
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
   * Instance control accepts `ios:<id>:all`, `android:<id>:all`, `xcode:<id>:all`,
   * and `gradle:<id>:all`. Use the returned instance ID, including `sandbox_` for Xcode.
   * iOS and Android accept `ios:<id>:watch` and `android:<id>:watch` for watch-only
   * streaming, or `ios:<id>:stream` and `android:<id>:stream` for
   * interactive streaming without device API or app-management access.
   * Instance wildcards and other instance actions are not accepted.
   * See https://docs.limrun.com/docs/reference/permissions for targets and actions.
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
