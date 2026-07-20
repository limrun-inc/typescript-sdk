/**
 * Session-authenticated App Store Connect operations, proxied through the
 * relay. These ride the same Apple login as the Developer Portal calls but
 * talk to the JSON:API (`iris`) and session (`olympus`) endpoints the App
 * Store Connect website uses.
 */
import { fetchAppleAccountSession, type AppleRelayWebSocketClient } from './relay';
import type { AppleRelayClientOptions } from './portal';

/**
 * A session-authenticated App Store Connect request. Payloads pass through
 * as JSON and GET parameters go into an explicit query map because the App
 * Store Connect API uses bracketed JSON:API keys like fields[apiKeys].
 */
export type AppStoreConnectRequest = {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  payload?: unknown;
};

/**
 * A JSON:API resource returned by the session-authenticated App Store
 * Connect API. Kept loose on purpose: the endpoint is not a public contract
 * and Apple adds attributes freely.
 */
export type AppStoreConnectResource = {
  type?: string;
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
};

type AppStoreConnectEnvelope = {
  data?: AppStoreConnectResource | AppStoreConnectResource[];
  included?: AppStoreConnectResource[];
  errors?: Array<{ status?: string; code?: string; title?: string; detail?: string }>;
};

async function appStoreConnectRequest(
  relay: AppleRelayWebSocketClient,
  request: AppStoreConnectRequest,
  label: string,
) {
  const response = await relay.request<AppStoreConnectEnvelope>('appstoreconnect', request);
  const errors = response.body?.errors;
  if (errors && errors.length > 0) {
    const detail = errors
      .map((error) => error.detail ?? error.title ?? error.code ?? error.status)
      .filter(Boolean)
      .join('; ');
    throw new Error(`${label} failed: ${detail || `HTTP ${response.status}`}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed: HTTP ${response.status} ${response.rawBody ?? ''}`.trim());
  }
  return response;
}

export type SwitchAppStoreConnectProviderOptions = AppleRelayClientOptions & {
  /** The numeric provider ID of the team, from the team list's providerId. */
  providerId: string | number;
};

/**
 * Points the App Store Connect session at the given team (provider). Must
 * run before any other App Store Connect call when the account belongs to
 * multiple teams, because the session carries an active provider.
 */
export async function switchAppStoreConnectProvider({
  relay,
  providerId,
}: SwitchAppStoreConnectProviderOptions) {
  const numericProviderId = Number(providerId);
  return appStoreConnectRequest(
    relay,
    {
      method: 'POST',
      path: '/olympus/v1/session',
      payload: {
        provider: { providerId: Number.isNaN(numericProviderId) ? providerId : numericProviderId },
      },
    },
    'App Store Connect provider switch',
  );
}

/**
 * Roles Apple accepts on App Store Connect API keys. APP_MANAGER is enough
 * to upload builds and manage TestFlight, which is why it is the default
 * for keys minted by ensureAppStoreConnectApiKeySecret.
 */
export type AppStoreConnectApiKeyRole =
  | 'ADMIN'
  | 'APP_MANAGER'
  | 'CUSTOMER_SUPPORT'
  | 'DEVELOPER'
  | 'FINANCE'
  | 'MARKETING'
  | 'SALES';

/** Lists the team's App Store Connect API keys. Requires an Admin session. */
export async function listAppStoreConnectApiKeys({ relay }: AppleRelayClientOptions) {
  const response = await appStoreConnectRequest(
    relay,
    { path: '/iris/v1/apiKeys' },
    'App Store Connect API key list',
  );
  return resourceArray(response.body?.data);
}

export type CreateAppStoreConnectApiKeyOptions = AppleRelayClientOptions & {
  /** Display name of the key. Required; implementors brand keys themselves. */
  nickname: string;
  roles?: AppStoreConnectApiKeyRole[];
  allAppsVisible?: boolean;
};

/**
 * Creates a team App Store Connect API key through the logged-in session,
 * the same way the App Store Connect website does. The session user must
 * be a team Admin. The private key is NOT part of the response; download
 * it once with downloadAppStoreConnectApiKeyPrivateKey.
 */
export async function createAppStoreConnectApiKey({
  relay,
  nickname,
  roles = ['APP_MANAGER'],
  allAppsVisible = true,
}: CreateAppStoreConnectApiKeyOptions) {
  if (!nickname) {
    throw new Error('A nickname is required to create an App Store Connect API key.');
  }
  const response = await appStoreConnectRequest(
    relay,
    {
      method: 'POST',
      path: '/iris/v1/apiKeys',
      payload: {
        data: {
          type: 'apiKeys',
          attributes: { nickname, allAppsVisible, keyType: 'PUBLIC_API', roles },
        },
      },
    },
    'App Store Connect API key creation',
  );
  const key = singleResource(response.body?.data);
  if (!key?.id) {
    throw new Error('App Store Connect API key creation did not return a key ID.');
  }
  return key;
}

export type DownloadAppStoreConnectApiKeyOptions = AppleRelayClientOptions & {
  keyId: string;
};

export type DownloadedAppStoreConnectApiKey = {
  /** PEM contents of the .p8 private key. */
  privateKeyPem: string;
  /** Issuer ID for JWTs signed with this key, when Apple returned it. */
  issuerId?: string;
};

/**
 * Downloads the private half of an App Store Connect API key. Apple serves
 * it exactly once per key; afterwards the sparse fieldset comes back empty
 * and the key must be revoked and re-minted.
 */
export async function downloadAppStoreConnectApiKeyPrivateKey({
  relay,
  keyId,
}: DownloadAppStoreConnectApiKeyOptions): Promise<DownloadedAppStoreConnectApiKey> {
  // The provider relationship must be listed in the sparse fieldset too:
  // with only `privateKey` requested, JSON:API strips the relationship and
  // `include=provider` comes back empty, losing the issuer ID.
  const response = await appStoreConnectRequest(
    relay,
    {
      path: `/iris/v1/apiKeys/${encodeURIComponent(keyId)}`,
      query: { 'fields[apiKeys]': 'privateKey,provider', include: 'provider' },
    },
    'App Store Connect API key download',
  );
  const key = singleResource(response.body?.data);
  const rawPrivateKey = stringAttribute(key?.attributes, 'privateKey');
  if (!rawPrivateKey) {
    throw new Error(
      `App Store Connect API key ${keyId} returned no private key. Apple serves it only once; ` +
        'revoke the key and create a new one.',
    );
  }
  const privateKeyPem = privateKeyPemFromDownload(rawPrivateKey, keyId);
  const provider = (response.body?.included ?? []).find((item) => item.type === 'providers');
  const issuerId =
    stringAttribute(provider?.attributes, 'publicProviderId') ??
    stringAttribute(key?.attributes, 'issuerId') ??
    provider?.id ??
    (await fetchAppStoreConnectIssuerId(relay));
  return { privateKeyPem, issuerId };
}

/**
 * Issuer ID of the session's active provider (team), read from the olympus
 * session. Team API keys must sign their JWTs with this as `iss`; a token
 * signed without it is rejected with 401 NOT_AUTHORIZED.
 */
export async function fetchAppStoreConnectIssuerId(
  relay: AppleRelayWebSocketClient,
): Promise<string | undefined> {
  const response = await fetchAppleAccountSession(relay);
  const body = response.body as { provider?: { publicProviderId?: unknown } } | undefined;
  const value = body?.provider?.publicProviderId;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Apple serves the `privateKey` attribute as base64 of the .p8 PEM text,
 * not the PEM itself. Normalize to PEM so downstream consumers (which
 * base64-encode once for storage) do not end up with double encoding —
 * signing then fails with "not a valid EC private key".
 */
function privateKeyPemFromDownload(value: string, keyId: string): string {
  if (value.trimStart().startsWith('-----BEGIN')) {
    return value;
  }
  let decoded: string | undefined;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(value.trim()), (c) => c.charCodeAt(0)));
  } catch {
    // Not base64 either; fall through to the error below.
  }
  if (decoded && decoded.trimStart().startsWith('-----BEGIN')) {
    return decoded;
  }
  throw new Error(
    `App Store Connect API key ${keyId} returned a private key in an unrecognized format ` +
      '(expected PEM or base64-encoded PEM).',
  );
}

export type FindAppStoreConnectAppOptions = AppleRelayClientOptions & {
  bundleId: string;
};

/** Looks up the App Store Connect app record for a bundle ID, if any. */
export async function findAppStoreConnectApp({ relay, bundleId }: FindAppStoreConnectAppOptions) {
  const response = await appStoreConnectRequest(
    relay,
    { path: '/iris/v1/apps', query: { 'filter[bundleId]': bundleId } },
    'App Store Connect app lookup',
  );
  return resourceArray(response.body?.data).find(
    (app) => stringAttribute(app.attributes, 'bundleId') === bundleId,
  );
}

export type CreateAppStoreConnectAppOptions = AppleRelayClientOptions & {
  bundleId: string;
  /** App name shown on the App Store. Required; there is no default. */
  name: string;
  /** Unique internal identifier. Defaults to the bundle ID. */
  sku?: string;
  /** Primary App Store locale. Defaults to en-US. */
  primaryLocale?: string;
  /** Version string of the first App Store version. Defaults to 1.0. */
  versionString?: string;
};

/**
 * Creates the App Store Connect app record for a bundle ID. Only the
 * session-authenticated API can create app records (the key-authenticated
 * public API cannot), which is why this goes through the relay. The body
 * mirrors what the App Store Connect website and fastlane's produce send.
 */
export async function createAppStoreConnectApp({
  relay,
  bundleId,
  name,
  sku,
  primaryLocale = 'en-US',
  versionString = '1.0',
}: CreateAppStoreConnectAppOptions) {
  if (!name) {
    throw new Error('An app name is required to create an App Store Connect app record.');
  }
  const platform = 'IOS';
  const response = await appStoreConnectRequest(
    relay,
    {
      method: 'POST',
      path: '/iris/v1/apps',
      payload: {
        data: {
          type: 'apps',
          attributes: {
            sku: sku || bundleId,
            primaryLocale,
            bundleId,
          },
          relationships: {
            appStoreVersions: {
              data: [{ type: 'appStoreVersions', id: `\${store-version-${platform}}` }],
            },
            appInfos: {
              data: [{ type: 'appInfos', id: '${new-appInfo-id}' }],
            },
          },
        },
        included: [
          {
            type: 'appInfos',
            id: '${new-appInfo-id}',
            relationships: {
              appInfoLocalizations: {
                data: [{ type: 'appInfoLocalizations', id: '${new-appInfoLocalization-id}' }],
              },
            },
          },
          {
            type: 'appInfoLocalizations',
            id: '${new-appInfoLocalization-id}',
            attributes: { locale: primaryLocale, name },
          },
          {
            type: 'appStoreVersions',
            id: `\${store-version-${platform}}`,
            attributes: { platform, versionString },
            relationships: {
              appStoreVersionLocalizations: {
                data: [
                  { type: 'appStoreVersionLocalizations', id: `\${new-${platform}VersionLocalization-id}` },
                ],
              },
            },
          },
          {
            type: 'appStoreVersionLocalizations',
            id: `\${new-${platform}VersionLocalization-id}`,
            attributes: { locale: primaryLocale },
          },
        ],
      },
    },
    'App Store Connect app creation',
  );
  const app = singleResource(response.body?.data);
  if (!app?.id) {
    throw new Error('App Store Connect app creation did not return an app ID.');
  }
  return app;
}

export type EnsureAppStoreConnectAppOptions = CreateAppStoreConnectAppOptions;

/**
 * Returns the App Store Connect app record for the bundle ID, creating it
 * when it does not exist yet. A first-time IPA upload fails without an app
 * record, so run this before the first publish of a new bundle ID.
 */
export async function ensureAppStoreConnectApp(options: EnsureAppStoreConnectAppOptions) {
  const existing = await findAppStoreConnectApp({ relay: options.relay, bundleId: options.bundleId });
  if (existing) {
    return { app: existing, created: false };
  }
  return { app: await createAppStoreConnectApp(options), created: true };
}

function resourceArray(data: AppStoreConnectResource | AppStoreConnectResource[] | undefined) {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function singleResource(data: AppStoreConnectResource | AppStoreConnectResource[] | undefined) {
  if (!data) return undefined;
  return Array.isArray(data) ? data[0] : data;
}

function stringAttribute(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
