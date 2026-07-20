import {
  createAdHocProfileRequest,
  createAppStoreProfileRequest,
  createBundleIDRequest,
  createDevelopmentProfileRequest,
  downloadCertificateRequest,
  downloadDistributionCertificateRequest,
  downloadProfileRequest,
  findAdHocProfilesRequest,
  findAppStoreProfilesRequest,
  findBundleIDRequest,
  findDevelopmentCertificatesRequest,
  findDevelopmentProfilesRequest,
  findDeviceRequest,
  findDistributionCertificatesRequest,
  fetchAppleAccountSession,
  listTeamsRequest,
  proxyAppStoreConnectRequest,
  proxyProvisioningRequest,
  registerDeviceRequest,
  submitDevelopmentCSRRequest,
  submitDistributionCSRRequest,
  type AppleDeveloperPortalAppID,
  type AppleDeveloperPortalDevice,
  type AppleDeveloperPortalResponse,
  type AppleDeveloperPortalTeam,
  type AppleProvisioningRequest,
  type AppleRelayResponse,
  type AppleRelayWebSocketClient,
} from '../core/device-install/apple';

export * from '../core/device-install/apple/client';
export * from '../core/device-install/apple/crypto';
export * from '../core/device-install/apple/gsa-srp';
export type {
  AppleDeveloperPortalAppID,
  AppleDeveloperPortalDevice,
  AppleDeveloperPortalResponse,
  AppleDeveloperPortalTeam,
  AppleProvisioningRequest,
  AppleRelayResponse,
  AppStoreConnectRequest,
} from '../core/device-install/apple';
export {
  AppleRelayWebSocketClient,
  fetchAppleAccountSession,
  openAppleRelayWebSocket,
  proxyAppStoreConnectRequest,
  proxyPhoneTwoFactorCode,
  proxySrpComplete,
  proxySrpInit,
  proxyTwoFactorCode,
  triggerPhoneTwoFactor,
  triggerTrustedDeviceTwoFactor,
} from '../core/device-install/apple';

export type AppleRelayClientOptions = {
  relay: AppleRelayWebSocketClient;
};

export type AppleTeamScopedOptions = AppleRelayClientOptions & {
  teamId?: string;
};

export type AppleCertificateKind = 'development' | 'distribution';

export type AppleProfileKind = 'development' | 'adhoc' | 'appstore';

export type RequestAppleProvisioningOptions<T = unknown> = AppleRelayClientOptions & {
  request: AppleProvisioningRequest;
  label?: string;
  validatePortalResponse?: boolean;
  mapBody?: (body: AppleDeveloperPortalResponse | undefined, response: AppleRelayResponse<T>) => T;
};

export type MappedAppleProvisioningOptions<T> = RequestAppleProvisioningOptions<T> & {
  mapBody: (body: AppleDeveloperPortalResponse | undefined, response: AppleRelayResponse<T>) => T;
};

export type ListAppleCertificatesOptions = AppleTeamScopedOptions & {
  certificateKind?: AppleCertificateKind;
};

export type CreateAppleCertificateOptions = AppleTeamScopedOptions & {
  certificateKind?: AppleCertificateKind;
  csrPEM: string;
};

export type DownloadAppleCertificateOptions = AppleTeamScopedOptions & {
  certificateKind?: AppleCertificateKind;
  certificateId: string;
};

export type DeleteAppleCertificateOptions = DownloadAppleCertificateOptions;

export type ListAppleBundleIDsOptions = AppleTeamScopedOptions & {
  search?: string;
};

export type CreateAppleBundleIDOptions = AppleTeamScopedOptions & {
  bundleId: string;
  name?: string;
};

export type UpdateAppleBundleIDOptions = AppleTeamScopedOptions & {
  appIdId: string;
  bundleId?: string;
  name?: string;
};

export type DeleteAppleBundleIDOptions = AppleTeamScopedOptions & {
  appIdId: string;
};

export type ListAppleDevicesOptions = AppleTeamScopedOptions & {
  deviceUDID?: string;
};

export type RegisterAppleDeviceOptions = AppleTeamScopedOptions & {
  deviceUDID: string;
  name?: string;
};

export type UpdateAppleDeviceOptions = AppleTeamScopedOptions & {
  deviceId: string;
  name?: string;
};

export type DeleteAppleDeviceOptions = AppleTeamScopedOptions & {
  deviceId: string;
};

export type ListAppleProfilesOptions = AppleTeamScopedOptions & {
  profileKind?: AppleProfileKind;
  /**
   * Narrows the result to profiles bound to this bundle ID. Applied
   * client-side (Apple's list endpoint rejects bundle-id-shaped search
   * values); rows that do not expose their bound bundle ID are kept.
   */
  bundleId?: string;
};

export type CreateAppleProfileOptions = AppleTeamScopedOptions & {
  profileKind?: AppleProfileKind;
  bundleId: string;
  appIdId: string;
  certificateIds: string[];
  /** Devices the profile binds. Ignored for App Store profiles, which bind none. */
  deviceIds?: string[];
  /** Profile name. Required for App Store profiles; there is no default. */
  name?: string;
};

export type DownloadAppleProfileOptions = AppleTeamScopedOptions & {
  profileId: string;
};

export type DeleteAppleProfileOptions = DownloadAppleProfileOptions;

export function requestAppleProvisioning<T>(options: MappedAppleProvisioningOptions<T>): Promise<T>;
export function requestAppleProvisioning<T = AppleDeveloperPortalResponse>(
  options: RequestAppleProvisioningOptions<T>,
): Promise<AppleRelayResponse<T>>;
export async function requestAppleProvisioning<T = AppleDeveloperPortalResponse>({
  relay,
  request,
  label = 'Apple Developer Portal request',
  validatePortalResponse = true,
  mapBody,
}: RequestAppleProvisioningOptions<T>) {
  const response = await proxyProvisioningRequest<T>(relay, request);
  if (validatePortalResponse) {
    assertAppleDeveloperPortalResponseOK(response.body as AppleDeveloperPortalResponse | undefined, label);
  }
  return mapBody ? mapBody(response.body as AppleDeveloperPortalResponse | undefined, response) : response;
}

export async function listAppleTeams(options: AppleRelayClientOptions) {
  return requestAppleProvisioning<AppleDeveloperPortalTeam[]>({
    ...options,
    request: listTeamsRequest(),
    label: 'Apple Developer team list',
    mapBody: (body) =>
      uniqueAppleTeams([
        ...(body?.teams ?? []),
        ...(body?.availableProviders ?? []),
        ...(body?.provider ? [body.provider] : []),
      ]),
  });
}

export async function listAppleCertificates({
  certificateKind = 'development',
  teamId = '',
  ...options
}: ListAppleCertificatesOptions) {
  return requestAppleProvisioning<Array<Record<string, unknown>>>({
    ...options,
    request:
      certificateKind === 'distribution' ?
        findDistributionCertificatesRequest(teamId)
      : findDevelopmentCertificatesRequest(teamId),
    label: 'Apple Developer certificate list',
    mapBody: (body) => body?.certRequests ?? [],
  });
}

export async function createAppleCertificate({
  certificateKind = 'development',
  teamId = '',
  csrPEM,
  ...options
}: CreateAppleCertificateOptions) {
  return requestAppleProvisioning<Record<string, unknown> | undefined>({
    ...options,
    request:
      certificateKind === 'distribution' ?
        submitDistributionCSRRequest({ csrPEM, teamID: teamId })
      : submitDevelopmentCSRRequest({ csrPEM, teamID: teamId }),
    label:
      certificateKind === 'distribution' ?
        'Apple Distribution certificate creation'
      : 'Apple Development certificate creation',
    mapBody: (body) => body?.certRequest,
  });
}

export async function downloadAppleCertificate({
  certificateKind = 'development',
  certificateId,
  teamId = '',
  ...options
}: DownloadAppleCertificateOptions) {
  return requestAppleProvisioning<AppleRelayResponse>({
    ...options,
    request:
      certificateKind === 'distribution' ?
        downloadDistributionCertificateRequest(certificateId, teamId)
      : downloadCertificateRequest(certificateId, teamId),
    label: 'Apple certificate download',
    validatePortalResponse: false,
    mapBody: (_body, response) => response,
  });
}

export async function deleteAppleCertificate({
  certificateKind = 'development',
  certificateId,
  teamId = '',
  ...options
}: DeleteAppleCertificateOptions) {
  return requestAppleProvisioning<AppleDeveloperPortalResponse | undefined>({
    ...options,
    request: {
      method: 'POST',
      path: '/account/ios/certificate/revokeCertificate.action',
      payload: {
        teamId,
        certificateId,
        type: certificateKind === 'distribution' ? 'WXV89964HE' : '83Q87W3TGH',
      },
    },
    label: 'Apple certificate deletion',
    mapBody: (body) => body,
  });
}

export async function listAppleBundleIDs({
  teamId = '',
  search = '',
  ...options
}: ListAppleBundleIDsOptions) {
  const query = search.trim().toLowerCase();
  return requestAppleProvisioning<AppleDeveloperPortalAppID[]>({
    ...options,
    request: findBundleIDRequest({ bundleID: search, teamID: teamId }),
    label: 'Apple bundle ID list',
    // Apple's listAppIds.action returns the full paginated list and does not
    // honor a server-side search filter, so apply the `search` filter here.
    mapBody: (body) => {
      const appIds = body?.appIds ?? [];
      if (!query) return appIds;
      return appIds.filter((appId) =>
        [appId.identifier, appId.bundleId, appId.name].some(
          (value) => typeof value === 'string' && value.toLowerCase().includes(query),
        ),
      );
    },
  });
}

export async function createAppleBundleID({
  teamId = '',
  bundleId,
  name,
  ...options
}: CreateAppleBundleIDOptions) {
  return requestAppleProvisioning<Record<string, unknown> | undefined>({
    ...options,
    request: createBundleIDRequest({ bundleID: bundleId, teamID: teamId, name }),
    label: 'Apple bundle ID creation',
    mapBody: (body) => body?.appId,
  });
}

export async function updateAppleBundleID({
  teamId = '',
  appIdId,
  bundleId,
  name,
  ...options
}: UpdateAppleBundleIDOptions) {
  return requestAppleProvisioning<Record<string, unknown> | undefined>({
    ...options,
    request: {
      method: 'POST',
      path: '/account/ios/identifiers/updateAppId.action',
      payload: {
        teamId,
        appIdId,
        ...(bundleId ? { identifier: bundleId } : {}),
        ...(name ? { name } : {}),
      },
    },
    label: 'Apple bundle ID update',
    mapBody: (body) => body?.appId,
  });
}

export async function deleteAppleBundleID({ teamId = '', appIdId, ...options }: DeleteAppleBundleIDOptions) {
  return requestAppleProvisioning<AppleDeveloperPortalResponse | undefined>({
    ...options,
    request: {
      method: 'POST',
      path: '/account/ios/identifiers/deleteAppId.action',
      payload: { teamId, appIdId },
    },
    label: 'Apple bundle ID deletion',
    mapBody: (body) => body,
  });
}

export async function listAppleDevices({
  teamId = '',
  deviceUDID = '',
  ...options
}: ListAppleDevicesOptions) {
  const wantedUDID = normalizeAppleUDID(deviceUDID);
  return requestAppleProvisioning<AppleDeveloperPortalDevice[]>({
    ...options,
    request: findDeviceRequest({ deviceUDID, teamID: teamId }),
    label: 'Apple device list',
    // Apple's listDevices.action returns the full paginated list and does not
    // honor a server-side UDID filter, so apply the `deviceUDID` filter here.
    mapBody: (body) => {
      const devices = body?.devices ?? [];
      if (!wantedUDID) return devices;
      return devices.filter((device) => normalizeAppleUDID(device.deviceNumber) === wantedUDID);
    },
  });
}

function normalizeAppleUDID(udid?: string) {
  return (udid ?? '')
    .replace(/-/g, '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toUpperCase();
}

export async function registerAppleDevice({
  teamId = '',
  deviceUDID,
  name,
  ...options
}: RegisterAppleDeviceOptions) {
  return requestAppleProvisioning<Record<string, unknown> | undefined>({
    ...options,
    request: registerDeviceRequest({ deviceUDID, teamID: teamId, name }),
    label: 'Apple device registration',
    mapBody: (body) => body?.device,
  });
}

export async function updateAppleDevice({
  teamId = '',
  deviceId,
  name,
  ...options
}: UpdateAppleDeviceOptions) {
  return requestAppleProvisioning<Record<string, unknown> | undefined>({
    ...options,
    request: {
      method: 'POST',
      path: '/account/ios/device/updateDevice.action',
      payload: { teamId, deviceId, ...(name ? { name } : {}) },
    },
    label: 'Apple device update',
    mapBody: (body) => body?.device,
  });
}

export async function deleteAppleDevice({ teamId = '', deviceId, ...options }: DeleteAppleDeviceOptions) {
  return requestAppleProvisioning<AppleDeveloperPortalResponse | undefined>({
    ...options,
    request: {
      method: 'POST',
      path: '/account/ios/device/deleteDevice.action',
      payload: { teamId, deviceId },
    },
    label: 'Apple device deletion',
    mapBody: (body) => body,
  });
}

export async function listAppleProfiles({
  profileKind = 'development',
  teamId = '',
  bundleId = '',
  ...options
}: ListAppleProfilesOptions) {
  const wanted = bundleId.trim();
  return requestAppleProvisioning<Array<Record<string, unknown>>>({
    ...options,
    request:
      profileKind === 'adhoc' ? findAdHocProfilesRequest(teamId)
      : profileKind === 'appstore' ? findAppStoreProfilesRequest(teamId)
      : findDevelopmentProfilesRequest(teamId),
    label: 'Apple provisioning profile list',
    // The bundle ID filter is client-side and permissive: Apple's list
    // endpoint rejects bundle-id-shaped `search` values, and its rows do
    // not always expose the bound bundle ID. Rows that clearly bind a
    // different bundle ID are dropped; indeterminate rows are kept so
    // callers matching by name or profile ID still find their profile.
    mapBody: (body) => {
      const profiles = body?.provisioningProfiles ?? [];
      if (!wanted) return profiles;
      return profiles.filter((profile) => {
        const bound = profileBoundBundleId(profile);
        return bound === undefined || bound === wanted;
      });
    },
  });
}

/** The bundle ID a portal profile row binds, when the row exposes it. */
function profileBoundBundleId(profile: Record<string, unknown>): string | undefined {
  const appId = profile.appId;
  if (!appId || typeof appId !== 'object') return undefined;
  const record = appId as Record<string, unknown>;
  const value = record.identifier ?? record.bundleId;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export async function createAppleProfile({
  profileKind = 'development',
  teamId = '',
  bundleId,
  appIdId,
  certificateIds,
  deviceIds = [],
  name,
  ...options
}: CreateAppleProfileOptions) {
  const [certificateId] = certificateIds;
  if (!certificateId) {
    throw new Error('At least one certificate ID is required to create an Apple provisioning profile.');
  }
  let request: AppleProvisioningRequest;
  if (profileKind === 'appstore') {
    if (!name) {
      throw new Error('An explicit name is required to create an App Store provisioning profile.');
    }
    request = createAppStoreProfileRequest({
      teamID: teamId,
      appIDID: appIdId,
      certificateID: certificateId,
      name,
    });
  } else if (profileKind === 'adhoc') {
    request = createAdHocProfileRequest({
      bundleID: bundleId,
      teamID: teamId,
      appIDID: appIdId,
      certificateID: certificateId,
      deviceIDs: deviceIds,
      name,
    });
  } else {
    request = createDevelopmentProfileRequest({
      bundleID: bundleId,
      teamID: teamId,
      appIDID: appIdId,
      certificateID: certificateId,
      deviceIDs: deviceIds,
      name,
    });
  }
  return requestAppleProvisioning<Record<string, unknown> | undefined>({
    ...options,
    request,
    label: 'Apple provisioning profile creation',
    mapBody: (body) => body?.provisioningProfile,
  });
}

export async function downloadAppleProfile({
  teamId = '',
  profileId,
  ...options
}: DownloadAppleProfileOptions) {
  return requestAppleProvisioning<AppleRelayResponse>({
    ...options,
    request: downloadProfileRequest(profileId, teamId),
    label: 'Apple provisioning profile download',
    validatePortalResponse: false,
    mapBody: (_body, response) => response,
  });
}

export async function deleteAppleProfile({ teamId = '', profileId, ...options }: DeleteAppleProfileOptions) {
  return requestAppleProvisioning<AppleDeveloperPortalResponse | undefined>({
    ...options,
    request: {
      method: 'POST',
      path: '/account/ios/profile/deleteProvisioningProfile.action',
      payload: { teamId, provisioningProfileId: profileId },
    },
    label: 'Apple provisioning profile deletion',
    mapBody: (body) => body,
  });
}

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
  const response = await proxyAppStoreConnectRequest<Record<string, unknown>>(relay, {
    method: 'POST',
    path: '/olympus/v1/session',
    payload: {
      provider: { providerId: Number.isNaN(numericProviderId) ? providerId : numericProviderId },
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `App Store Connect provider switch failed: HTTP ${response.status} ${response.rawBody ?? ''}`.trim(),
    );
  }
  return response;
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

export type ListAppStoreConnectApiKeysOptions = AppleRelayClientOptions;

/** Lists the team's App Store Connect API keys. Requires an Admin session. */
export async function listAppStoreConnectApiKeys({ relay }: ListAppStoreConnectApiKeysOptions) {
  const response = await proxyAppStoreConnectRequest<AppStoreConnectEnvelope>(relay, {
    path: '/iris/v1/apiKeys',
  });
  assertAppStoreConnectResponseOK(response, 'App Store Connect API key list');
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
  const response = await proxyAppStoreConnectRequest<AppStoreConnectEnvelope>(relay, {
    method: 'POST',
    path: '/iris/v1/apiKeys',
    payload: {
      data: {
        type: 'apiKeys',
        attributes: {
          nickname,
          allAppsVisible,
          keyType: 'PUBLIC_API',
          roles,
        },
      },
    },
  });
  assertAppStoreConnectResponseOK(response, 'App Store Connect API key creation');
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
  const response = await proxyAppStoreConnectRequest<AppStoreConnectEnvelope>(relay, {
    path: `/iris/v1/apiKeys/${encodeURIComponent(keyId)}`,
    query: { 'fields[apiKeys]': 'privateKey,provider', include: 'provider' },
  });
  assertAppStoreConnectResponseOK(response, 'App Store Connect API key download');
  const key = singleResource(response.body?.data);
  const rawPrivateKey = stringField(key?.attributes, 'privateKey');
  if (!rawPrivateKey) {
    throw new Error(
      `App Store Connect API key ${keyId} returned no private key. Apple serves it only once; ` +
        'revoke the key and create a new one.',
    );
  }
  const privateKeyPem = privateKeyPemFromDownload(rawPrivateKey, keyId);
  const provider = (response.body?.included ?? []).find((item) => item.type === 'providers');
  const issuerId =
    stringField(provider?.attributes, 'publicProviderId') ??
    stringField(key?.attributes, 'issuerId') ??
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
  const response = await proxyAppStoreConnectRequest<AppStoreConnectEnvelope>(relay, {
    path: '/iris/v1/apps',
    query: { 'filter[bundleId]': bundleId },
  });
  assertAppStoreConnectResponseOK(response, 'App Store Connect app lookup');
  return resourceArray(response.body?.data).find(
    (app) => stringField(app.attributes, 'bundleId') === bundleId,
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
  const response = await proxyAppStoreConnectRequest<AppStoreConnectEnvelope>(relay, {
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
  });
  assertAppStoreConnectResponseOK(response, 'App Store Connect app creation');
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

export function assertAppStoreConnectResponseOK(
  response: AppleRelayResponse<AppStoreConnectEnvelope>,
  label: string,
) {
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
}

function resourceArray(data: AppStoreConnectResource | AppStoreConnectResource[] | undefined) {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function singleResource(data: AppStoreConnectResource | AppStoreConnectResource[] | undefined) {
  if (!data) return undefined;
  return Array.isArray(data) ? data[0] : data;
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function assertAppleDeveloperPortalResponseOK(
  response: AppleDeveloperPortalResponse | undefined,
  label: string,
) {
  if (!response) {
    throw new Error(`${label} returned an empty response.`);
  }
  if (response.resultCode !== undefined && response.resultCode !== 0) {
    throw new Error(
      `${label} failed: ${response.userString ?? response.resultString ?? response.resultCode}`,
    );
  }
}

function uniqueAppleTeams(teams: AppleDeveloperPortalTeam[]) {
  const seen = new Set<string>();
  const result: AppleDeveloperPortalTeam[] = [];
  for (const team of teams) {
    const key = String(
      team.teamId ?? team.providerId ?? team.publicProviderId ?? team.name ?? JSON.stringify(team),
    );
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(team);
  }
  return result;
}
