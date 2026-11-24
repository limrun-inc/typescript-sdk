import type { MergedRequestInit } from '../internal/types';

/** A workload JWT, or a function that returns the current one on every exchange. */
export type WorkloadToken = string | (() => string | Promise<string>);

/**
 * Returns the identity JWT to exchange, read again for every exchange. Null means an egress proxy
 * adds the JWT to the exchange request, so the client sends none.
 */
export type WorkloadIdentityReader = () => Promise<string | null>;

export const injectedWorkloadIdentityReader: WorkloadIdentityReader = async () => null;

export function workloadTokenReader(token: WorkloadToken): WorkloadIdentityReader {
  return async () => (typeof token === 'function' ? await token() : token);
}

export function workloadTokenFileReader(path: string): WorkloadIdentityReader {
  return async () => {
    const { readFile } = await import('node:fs/promises');
    return readFile(path, 'utf8');
  };
}

/** Refreshes workload credentials without retaining the identity JWT. */
export class WorkloadCredentials {
  private cached?: { token: string; expires: number; refreshAt: number };
  private pending: Promise<string> | undefined;

  constructor(
    private endpoint: string,
    private readIdentity: WorkloadIdentityReader,
    private fetcher: typeof fetch,
    private fetchOptions?: MergedRequestInit,
    private bindingId?: string,
  ) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.refreshAt > Date.now()) return this.cached.token;
    if (!this.pending)
      this.pending = this.exchange().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const identity = await this.readIdentity();
    const jwt =
      identity === null ? undefined
      : typeof identity === 'string' ? identity.trim()
      : '';
    if (jwt !== undefined && (!jwt || jwt.length > 32768))
      throw new Error('Workload identity token must be a JWT of at most 32768 characters');
    const start = Date.now();
    const response = await this.fetcher(`${this.endpoint.replace(/\/$/, '')}/v1/access_tokens`, {
      ...(this.fetchOptions as RequestInit),
      method: 'POST',
      headers:
        this.bindingId ?
          { 'Content-Type': 'application/x-www-form-urlencoded' }
        : { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body:
        this.bindingId ?
          new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            ...(jwt !== undefined && { subject_token: jwt }),
            audience: this.bindingId,
          }).toString()
        : JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Workload token exchange returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      token?: string;
      expiresAt: string;
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    const token = this.bindingId ? body.access_token : body.token;
    if (typeof token !== 'string' || !token)
      throw new Error('Workload token exchange returned no access token');
    if (
      this.bindingId &&
      (body.token_type !== 'Bearer' ||
        typeof body.expires_in !== 'number' ||
        !Number.isInteger(body.expires_in) ||
        body.expires_in < 1 ||
        body.expires_in > 14400)
    )
      throw new Error('Workload token exchange returned an invalid token response');
    const expires = this.bindingId ? start + body.expires_in! * 1000 : Date.parse(body.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now())
      throw new Error('Workload token exchange returned an invalid expiration');
    this.cached = { token, expires, refreshAt: expires - Math.min(60_000, (expires - start) * 0.2) };
    return token;
  }
}
