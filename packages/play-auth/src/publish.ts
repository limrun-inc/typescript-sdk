export type PlaystorePublishInput = {
  registryApiUrl: string;
  /** Limrun API token authenticating the registry call. */
  token?: string;
  /** Organization tid; required when it differs from the token's default organization. */
  organizationId?: string;
  /** Google OAuth access token with the androidpublisher scope. Sent per request, never stored. */
  accessToken: string;
  packageName: string;
  assetId?: string;
  assetName?: string;
  /** Play track ID, defaults to internal on the server. */
  track?: string;
  /** Required by the server when track is production. */
  releaseStatus?: 'draft' | 'completed';
};

export type PlaystorePublishResult = {
  versionCode: number;
};

/**
 * Registry publish failure. `code` carries the registry's machine-readable
 * error code when available: invalidRequest, assetNotFound, internal, busy,
 * listingNotFound, permissionDenied, versionCodeExists, uploadKeyMismatch
 * or unknown; the set grows additively.
 */
export class PlaystorePublishError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'PlaystorePublishError';
    this.code = options.code;
    this.status = options.status;
  }
}

export async function publishToPlaystore(input: PlaystorePublishInput): Promise<PlaystorePublishResult> {
  const { registryApiUrl, token, organizationId, ...body } = input;
  let url: URL;
  try {
    url = new URL(registryApiUrl);
  } catch {
    throw new PlaystorePublishError(`Invalid registry URL: ${registryApiUrl}`);
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/android/playstore/publish`;
  url.search = '';
  url.hash = '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (organizationId) {
    headers['X-Limrun-Organization'] = organizationId;
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (caught) {
    throw new PlaystorePublishError(
      `Cannot reach the registry: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  const raw = await response.text();
  let parsed: { versionCode?: number; message?: string; code?: string } | undefined;
  try {
    parsed = raw ? (JSON.parse(raw) as typeof parsed) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    throw new PlaystorePublishError(parsed?.message || `Play publish failed with HTTP ${response.status}`, {
      code: parsed?.code,
      status: response.status,
    });
  }
  if (typeof parsed?.versionCode !== 'number') {
    throw new PlaystorePublishError('Play publish response is missing versionCode.', {
      status: response.status,
    });
  }
  return { versionCode: parsed.versionCode };
}
