/** Refreshes workload credentials without retaining the projected JWT. */
export class WorkloadCredentials {
  private cached?: { token: string; expires: number };
  private pending: Promise<string> | undefined;

  constructor(
    private endpoint: string,
    private tokenFile: string,
    private fetcher: typeof fetch,
  ) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expires - Date.now() > 60_000) return this.cached.token;
    if (!this.pending)
      this.pending = this.exchange().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const jwt = (await readFile(this.tokenFile, 'utf8')).trim();
    const response = await this.fetcher(`${this.endpoint.replace(/\/$/, '')}/v1/workload_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Workload token exchange returned HTTP ${response.status}`);
    const body = (await response.json()) as { token?: string; expiresAt: string };
    if (!body.token) throw new Error('This instance has no workload asset permissions');
    const expires = Date.parse(body.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now())
      throw new Error('Workload token exchange returned an invalid expiration');
    this.cached = { token: body.token, expires };
    return body.token;
  }
}
