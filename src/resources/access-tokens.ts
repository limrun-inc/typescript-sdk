import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class AccessTokens extends APIResource {
  /** Mint an access token limited to the requested scopes and the caller's organization. */
  create(body: AccessTokenCreateParams, options?: RequestOptions): APIPromise<AccessToken> {
    return this._client.post('/v1/access_tokens', { body, ...options });
  }

  /** Revoke an access token using the ID returned when it was created. */
  revoke(tokenID: string, options?: RequestOptions): APIPromise<AccessTokenRevokeResponse> {
    return this._client.delete(path`/v1/access_tokens/${tokenID}`, options);
  }
}

export interface AccessToken {
  id: string;
  /** Send this value as a Bearer credential. */
  token: string;
  expiresAt: string;
  scopes: Array<string>;
}

export interface AccessTokenCreateParams {
  /** Scopes in the form <resource>:<id|*>:<action>, such as asset:asset_01h455vb4pex5vsknk084sn02q:read. */
  scopes: Array<string>;
  /** Lifetime in seconds. Defaults to 3600 (1 hour); maximum 14400 (4 hours). */
  ttlSeconds?: number;
}

export interface AccessTokenRevokeResponse {
  status: string;
}

export declare namespace AccessTokens {
  export { type AccessToken, type AccessTokenCreateParams, type AccessTokenRevokeResponse };
}
