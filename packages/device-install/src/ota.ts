export type OTAInstallState = 'waitingForManifest' | 'downloading' | 'downloaded' | 'failed' | 'expired';

export type OTAInstallSession = {
  id: string;
  installPageUrl: string;
  statusUrl: string;
  expiresAt: string;
};

export type OTAInstallStatus = {
  id: string;
  state: OTAInstallState;
  bytesTransferred: number;
  totalBytes: number;
  progress: number;
  error?: string;
  expiresAt: string;
};

export type CreateOTAInstallSessionOptions = {
  registryApiUrl: string;
  token: string;
  organizationId?: string;
  assetId: string;
  /**
   * CFBundleIdentifier of the signed IPA. Defaults to the metadata limbuild
   * recorded on the asset at build time; required only when the asset
   * carries none (e.g. a hand-uploaded IPA).
   */
  bundleIdentifier?: string;
  /** CFBundleShortVersionString. Defaults to the asset's recorded metadata. */
  shortVersion?: string;
  /**
   * CFBundleVersion. Defaults to the asset's recorded metadata; required
   * only when the asset carries none.
   */
  buildVersion?: string;
  /**
   * App title shown on the install page and in the iOS install prompt.
   * Defaults to the display name recorded on the asset, then to the bundle
   * identifier.
   */
  title?: string;
  /**
   * URL the install page's Open button launches once the app is installed,
   * e.g. an Expo dev client URL. Defaults to the asset's recorded primary
   * URL scheme.
   */
  deepLink?: string;
  ttlSeconds?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
};

export type GetOTAInstallStatusOptions = {
  statusUrl: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
};

export async function createOTAInstallSession({
  registryApiUrl,
  token,
  organizationId,
  assetId,
  bundleIdentifier,
  shortVersion,
  buildVersion,
  title,
  deepLink,
  ttlSeconds,
  signal,
  fetch: fetchImplementation = globalThis.fetch,
}: CreateOTAInstallSessionOptions): Promise<OTAInstallSession> {
  const url = new URL(registryApiUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ios/ota/sessions`;
  url.search = '';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (organizationId) {
    headers['X-Limrun-Organization'] = organizationId;
  }
  const response = await fetchImplementation(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      assetId,
      ...(bundleIdentifier === undefined ? {} : { bundleIdentifier }),
      ...(shortVersion === undefined ? {} : { shortVersion }),
      ...(buildVersion === undefined ? {} : { buildVersion }),
      ...(title === undefined ? {} : { title }),
      ...(deepLink === undefined ? {} : { deepLink }),
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    }),
    signal,
  });
  return parseResponse<OTAInstallSession>(response, 'create OTA installation session');
}

export async function getOTAInstallStatus({
  statusUrl,
  signal,
  fetch: fetchImplementation = globalThis.fetch,
}: GetOTAInstallStatusOptions): Promise<OTAInstallStatus> {
  const response = await fetchImplementation(statusUrl, {
    cache: 'no-store',
    signal,
  });
  return parseResponse<OTAInstallStatus>(response, 'fetch OTA installation status');
}

async function parseResponse<T>(response: Response, action: string): Promise<T> {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ?
        body.message
      : `${response.status} ${response.statusText}`.trim();
    throw new Error(`Failed to ${action}: ${message}`);
  }
  return body as T;
}
