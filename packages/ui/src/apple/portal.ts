/**
 * CRUD operations against the Apple Developer Portal, proxied through the
 * relay. The portal is the pre-App-Store-Connect API the developer website
 * still uses; it is loosely typed and paginated, so list responses are
 * fetched as one large page and filtered client-side where Apple's own
 * filters are broken (bundle IDs, device UDIDs).
 */
import { normalizeUDID, sameUDID } from '../core/udid';
import type { AppleRelayResponse, AppleRelayWebSocketClient } from './relay';

export type AppleDeveloperPortalTeam = {
  name?: string;
  teamId?: string;
  providerId?: string | number;
  publicProviderId?: string;
  type?: string;
  subType?: string;
};

export type AppleDeveloperPortalDevice = {
  deviceId?: string;
  name?: string;
  deviceNumber?: string;
  deviceClass?: string;
  model?: string;
  status?: string;
};

export type AppleDeveloperPortalAppID = {
  appId?: string;
  appIdId?: string;
  identifier?: string;
  bundleId?: string;
  name?: string;
  prefix?: string;
  platform?: string;
};

export type AppleDeveloperPortalResponse = {
  resultCode?: number;
  resultString?: string;
  userString?: string;
  teams?: AppleDeveloperPortalTeam[];
  provider?: AppleDeveloperPortalTeam;
  availableProviders?: AppleDeveloperPortalTeam[];
  appIds?: AppleDeveloperPortalAppID[];
  devices?: AppleDeveloperPortalDevice[];
  certRequests?: Array<Record<string, unknown>>;
  certRequest?: Record<string, unknown>;
  appId?: Record<string, unknown>;
  device?: Record<string, unknown>;
  provisioningProfile?: Record<string, unknown>;
  provisioningProfiles?: Array<Record<string, unknown>>;
};

export type AppleRelayClientOptions = {
  relay: AppleRelayWebSocketClient;
};

export type AppleTeamScopedOptions = AppleRelayClientOptions & {
  teamId?: string;
};

export type AppleCertificateKind = 'development' | 'distribution';

export type AppleProfileKind = 'development' | 'adhoc' | 'appstore';

/**
 * Apple's opaque certificate type codes. `create` is the single type minted
 * by a CSR submission; `list` also matches the legacy variants of the same
 * kind so existing certificates show up.
 */
const CERTIFICATE_TYPES: Record<AppleCertificateKind, { create: string; list: string }> = {
  development: { create: '83Q87W3TGH', list: '83Q87W3TGH,5QPB9NHCEI' },
  distribution: { create: 'WXV89964HE', list: 'WXV89964HE,R58UK2EWSO' },
};

type PortalRequest = {
  method?: 'GET' | 'POST';
  path: string;
  payload?: unknown;
};

async function portalRequest(
  relay: AppleRelayWebSocketClient,
  request: PortalRequest,
  label: string,
): Promise<AppleDeveloperPortalResponse> {
  const response = await relay.request<AppleDeveloperPortalResponse>('provisioning', request);
  const body = response.body;
  if (!body) {
    throw new Error(`${label} returned an empty response.`);
  }
  if (body.resultCode !== undefined && body.resultCode !== 0) {
    throw new Error(`${label} failed: ${body.userString ?? body.resultString ?? body.resultCode}`);
  }
  return body;
}

/** A download endpoint returns raw bytes, not a portal result envelope. */
async function portalDownload(
  relay: AppleRelayWebSocketClient,
  request: PortalRequest,
): Promise<AppleRelayResponse> {
  return relay.request('provisioning', request);
}

function paged(path: string, teamId: string, payload: Record<string, unknown> = {}): PortalRequest {
  return {
    method: 'POST',
    path,
    payload: {
      pageNumber: 1,
      pageSize: 200,
      sort: 'name=asc',
      ...(teamId ? { teamId } : {}),
      ...payload,
    },
  };
}

export async function listAppleTeams({ relay }: AppleRelayClientOptions) {
  const body = await portalRequest(
    relay,
    { method: 'POST', path: '/account/listTeams.action', payload: {} },
    'Apple Developer team list',
  );
  return uniqueAppleTeams([
    ...(body.teams ?? []),
    ...(body.availableProviders ?? []),
    ...(body.provider ? [body.provider] : []),
  ]);
}

export type ListAppleCertificatesOptions = AppleTeamScopedOptions & {
  certificateKind?: AppleCertificateKind;
};

export async function listAppleCertificates({
  relay,
  teamId = '',
  certificateKind = 'development',
}: ListAppleCertificatesOptions) {
  const body = await portalRequest(
    relay,
    paged('/account/ios/certificate/listCertRequests.action', teamId, {
      types: CERTIFICATE_TYPES[certificateKind].list,
    }),
    'Apple Developer certificate list',
  );
  return body.certRequests ?? [];
}

export type CreateAppleCertificateOptions = AppleTeamScopedOptions & {
  certificateKind?: AppleCertificateKind;
  csrPEM: string;
};

export async function createAppleCertificate({
  relay,
  teamId = '',
  certificateKind = 'development',
  csrPEM,
}: CreateAppleCertificateOptions) {
  const body = await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/certificate/submitCertificateRequest.action',
      payload: { teamId, type: CERTIFICATE_TYPES[certificateKind].create, csrContent: csrPEM },
    },
    'Apple certificate creation',
  );
  return body.certRequest;
}

export type DownloadAppleCertificateOptions = AppleTeamScopedOptions & {
  certificateKind?: AppleCertificateKind;
  certificateId: string;
};

/** Returns the relay response; the certificate DER is in rawBodyBase64. */
export async function downloadAppleCertificate({
  relay,
  teamId = '',
  certificateKind = 'development',
  certificateId,
}: DownloadAppleCertificateOptions) {
  return portalDownload(relay, {
    method: 'GET',
    path: '/account/ios/certificate/downloadCertificateContent.action',
    payload: { teamId, certificateId, type: CERTIFICATE_TYPES[certificateKind].create },
  });
}

export type DeleteAppleCertificateOptions = AppleTeamScopedOptions & {
  certificateKind?: AppleCertificateKind;
  certificateId: string;
};

export async function deleteAppleCertificate({
  relay,
  teamId = '',
  certificateKind = 'development',
  certificateId,
}: DeleteAppleCertificateOptions) {
  return portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/certificate/revokeCertificate.action',
      payload: { teamId, certificateId, type: CERTIFICATE_TYPES[certificateKind].create },
    },
    'Apple certificate deletion',
  );
}

export type ListAppleBundleIDsOptions = AppleTeamScopedOptions & {
  search?: string;
};

// Apple's listAppIds.action returns the full paginated list and does not
// honor a server-side search filter, so the `search` filter applies here.
export async function listAppleBundleIDs({ relay, teamId = '', search = '' }: ListAppleBundleIDsOptions) {
  const body = await portalRequest(
    relay,
    paged('/account/ios/identifiers/listAppIds.action', teamId),
    'Apple bundle ID list',
  );
  const appIds = body.appIds ?? [];
  const query = search.trim().toLowerCase();
  if (!query) return appIds;
  return appIds.filter((appId) =>
    [appId.identifier, appId.bundleId, appId.name].some(
      (value) => typeof value === 'string' && value.toLowerCase().includes(query),
    ),
  );
}

export type CreateAppleBundleIDOptions = AppleTeamScopedOptions & {
  bundleId: string;
  name?: string;
};

export async function createAppleBundleID({
  relay,
  teamId = '',
  bundleId,
  name,
}: CreateAppleBundleIDOptions) {
  const body = await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/identifiers/addAppId.action',
      payload: { teamId, name: name ?? bundleId, identifier: bundleId, type: 'explicit' },
    },
    'Apple bundle ID creation',
  );
  return body.appId;
}

export type DeleteAppleBundleIDOptions = AppleTeamScopedOptions & {
  appIdId: string;
};

export async function deleteAppleBundleID({ relay, teamId = '', appIdId }: DeleteAppleBundleIDOptions) {
  return portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/identifiers/deleteAppId.action',
      payload: { teamId, appIdId },
    },
    'Apple bundle ID deletion',
  );
}

export type ListAppleDevicesOptions = AppleTeamScopedOptions & {
  deviceUDID?: string;
};

// Like bundle IDs, the UDID filter is client-side: Apple's listDevices.action
// does not honor a server-side one.
export async function listAppleDevices({ relay, teamId = '', deviceUDID = '' }: ListAppleDevicesOptions) {
  const body = await portalRequest(
    relay,
    paged('/account/ios/device/listDevices.action', teamId, { includeRemovedDevices: false }),
    'Apple device list',
  );
  const devices = body.devices ?? [];
  if (!deviceUDID) return devices;
  return devices.filter((device) => sameUDID(device.deviceNumber, deviceUDID));
}

export type RegisterAppleDeviceOptions = AppleTeamScopedOptions & {
  deviceUDID: string;
  name?: string;
};

export async function registerAppleDevice({
  relay,
  teamId = '',
  deviceUDID,
  name = 'Limrun iPhone',
}: RegisterAppleDeviceOptions) {
  const body = await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/device/addDevices.action',
      payload: {
        teamId,
        deviceNames: name,
        deviceNumbers: normalizeUDID(deviceUDID),
        deviceClasses: 'iphone',
        register: 'single',
      },
    },
    'Apple device registration',
  );
  return body.device;
}

export type DeleteAppleDeviceOptions = AppleTeamScopedOptions & {
  deviceId: string;
};

export async function deleteAppleDevice({ relay, teamId = '', deviceId }: DeleteAppleDeviceOptions) {
  return portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/device/deleteDevice.action',
      payload: { teamId, deviceId },
    },
    'Apple device deletion',
  );
}

export type ListAppleProfilesOptions = AppleTeamScopedOptions & {
  profileKind?: AppleProfileKind;
  /**
   * Narrows the result to profiles bound to this bundle ID. Applied
   * client-side (Apple's list endpoint rejects bundle-id-shaped search
   * values); rows that do not expose their bound bundle ID are kept so
   * callers matching by name or profile ID still find their profile.
   */
  bundleId?: string;
};

export async function listAppleProfiles({
  relay,
  teamId = '',
  profileKind = 'development',
  bundleId = '',
}: ListAppleProfilesOptions) {
  const body = await portalRequest(
    relay,
    paged('/account/ios/profile/listProvisioningProfiles.action', teamId, {
      // The development listing is unfiltered on the portal side and returns
      // profiles of every distribution method.
      ...(profileKind === 'adhoc' ? { distributionType: 'adhoc' }
      : profileKind === 'appstore' ? { distributionType: 'store' }
      : {}),
    }),
    'Apple provisioning profile list',
  );
  const profiles = body.provisioningProfiles ?? [];
  const wanted = bundleId.trim();
  if (!wanted) return profiles;
  return profiles.filter((profile) => {
    const bound = profileBoundBundleId(profile);
    return bound === undefined || bound === wanted;
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

export async function createAppleProfile({
  relay,
  teamId = '',
  profileKind = 'development',
  bundleId,
  appIdId,
  certificateIds,
  deviceIds = [],
  name,
}: CreateAppleProfileOptions) {
  const [certificateId] = certificateIds;
  if (!certificateId) {
    throw new Error('At least one certificate ID is required to create an Apple provisioning profile.');
  }
  if (profileKind === 'appstore' && !name) {
    throw new Error('An explicit name is required to create an App Store provisioning profile.');
  }
  const body = await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/profile/createProvisioningProfile.action',
      payload: {
        teamId,
        provisioningProfileName:
          name ?? (profileKind === 'adhoc' ? `Limrun Ad Hoc ${bundleId}` : `Limrun ${bundleId}`),
        certificateIds: [certificateId],
        appIdId,
        distributionType:
          profileKind === 'appstore' ? 'store'
          : profileKind === 'adhoc' ? 'adhoc'
          : 'limited',
        subPlatform: 'ios',
        ...(profileKind === 'appstore' ? {} : { deviceIds }),
      },
    },
    'Apple provisioning profile creation',
  );
  return body.provisioningProfile;
}

export type DownloadAppleProfileOptions = AppleTeamScopedOptions & {
  profileId: string;
};

/** Returns the relay response; the .mobileprovision bytes are in rawBodyBase64. */
export async function downloadAppleProfile({ relay, teamId = '', profileId }: DownloadAppleProfileOptions) {
  return portalDownload(relay, {
    method: 'GET',
    path: '/account/ios/profile/downloadProfileContent',
    payload: { teamId, provisioningProfileId: profileId },
  });
}

export type DeleteAppleProfileOptions = AppleTeamScopedOptions & {
  profileId: string;
};

export async function deleteAppleProfile({ relay, teamId = '', profileId }: DeleteAppleProfileOptions) {
  return portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/profile/deleteProvisioningProfile.action',
      payload: { teamId, provisioningProfileId: profileId },
    },
    'Apple provisioning profile deletion',
  );
}

/** Read a string-ish value from a loosely typed portal record. */
export function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
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
