import type { DeviceInstallSigningMode, ProvisioningProfileInfo, StoredSigningAssets } from '../types';
import {
  getSigningAssets,
  normalizeBundleID,
  normalizeUDID,
  profileContainsDevice,
  profileMatchesBundleID,
  putSigningAssets,
} from '../storage';
import type { AppleProvisioningRequest } from './relay';

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

export type AppleProvisioningContext = {
  bundleID: string;
  deviceUDID: string;
  teamID?: string;
};

export type AppleSigningAssetCacheInput = {
  bundleID: string;
  deviceUDID?: string;
  teamID?: string;
  signingMode?: DeviceInstallSigningMode;
};

export type PutAppleGeneratedSigningAssetsInput = {
  bundleID: string;
  deviceUDID?: string;
  teamID?: string;
  signingMode?: DeviceInstallSigningMode;
  certificateID?: string;
  certificateP12Base64: string;
  certificatePassword?: string;
  provisioningProfileBase64: string;
  profile: ProvisioningProfileInfo;
};

export function listTeamsRequest(): AppleProvisioningRequest {
  return {
    method: 'POST',
    path: '/account/listTeams.action',
    payload: {},
  };
}

export function findBundleIDRequest({
  bundleID,
  teamID = '',
}: Pick<AppleProvisioningContext, 'bundleID' | 'teamID'>) {
  void bundleID;
  return pagedRequest('/account/ios/identifiers/listAppIds.action', teamID, { sort: 'name=asc' });
}

export function findDeviceRequest({
  deviceUDID,
  teamID = '',
}: Pick<AppleProvisioningContext, 'deviceUDID' | 'teamID'>) {
  void deviceUDID;
  return pagedRequest('/account/ios/device/listDevices.action', teamID, {
    sort: 'name=asc',
    includeRemovedDevices: false,
  });
}

export function findDevelopmentCertificatesRequest(teamID = '') {
  return pagedRequest('/account/ios/certificate/listCertRequests.action', teamID, {
    sort: 'name=asc',
    types: '83Q87W3TGH,5QPB9NHCEI',
  });
}

export function findDistributionCertificatesRequest(teamID = '') {
  return pagedRequest('/account/ios/certificate/listCertRequests.action', teamID, {
    sort: 'name=asc',
    types: 'WXV89964HE,R58UK2EWSO',
  });
}

export function findDevelopmentProfilesRequest({
  bundleID,
  teamID = '',
}: Pick<AppleProvisioningContext, 'bundleID' | 'teamID'>) {
  return pagedRequest('/account/ios/profile/listProvisioningProfiles.action', teamID, {
    search: bundleID,
    sort: 'name=asc',
  });
}

export function findAdHocProfilesRequest({
  bundleID,
  teamID = '',
}: Pick<AppleProvisioningContext, 'bundleID' | 'teamID'>) {
  return pagedRequest('/account/ios/profile/listProvisioningProfiles.action', teamID, {
    search: bundleID,
    sort: 'name=asc',
    distributionType: 'adhoc',
  });
}

export function registerDeviceRequest({
  deviceUDID,
  teamID = '',
  name = 'Limrun iPhone',
}: Pick<AppleProvisioningContext, 'deviceUDID' | 'teamID'> & { name?: string }) {
  return {
    method: 'POST',
    path: '/account/ios/device/addDevices.action',
    payload: {
      teamId: teamID,
      deviceNames: name,
      deviceNumbers: normalizeUDID(deviceUDID),
      deviceClasses: 'iphone',
      register: 'single',
    },
  } satisfies AppleProvisioningRequest;
}

export function createBundleIDRequest({
  bundleID,
  teamID = '',
  name,
}: Pick<AppleProvisioningContext, 'bundleID' | 'teamID'> & { name?: string }) {
  return {
    method: 'POST',
    path: '/account/ios/identifiers/addAppId.action',
    payload: {
      teamId: teamID,
      name: name ?? bundleID,
      identifier: bundleID,
      type: 'explicit',
    },
  } satisfies AppleProvisioningRequest;
}

export function submitDevelopmentCSRRequest({ csrPEM, teamID = '' }: { csrPEM: string; teamID?: string }) {
  return {
    method: 'POST',
    path: '/account/ios/certificate/submitCertificateRequest.action',
    payload: {
      teamId: teamID,
      type: '83Q87W3TGH',
      csrContent: csrPEM,
    },
  } satisfies AppleProvisioningRequest;
}

export function submitDistributionCSRRequest({ csrPEM, teamID = '' }: { csrPEM: string; teamID?: string }) {
  return {
    method: 'POST',
    path: '/account/ios/certificate/submitCertificateRequest.action',
    payload: {
      teamId: teamID,
      type: 'WXV89964HE',
      csrContent: csrPEM,
    },
  } satisfies AppleProvisioningRequest;
}

export function downloadCertificateRequest(certificateID: string, teamID = '') {
  return {
    method: 'GET',
    path: '/account/ios/certificate/downloadCertificateContent.action',
    payload: {
      teamId: teamID,
      certificateId: certificateID,
      type: '83Q87W3TGH',
    },
  } satisfies AppleProvisioningRequest;
}

export function downloadDistributionCertificateRequest(certificateID: string, teamID = '') {
  return {
    method: 'GET',
    path: '/account/ios/certificate/downloadCertificateContent.action',
    payload: {
      teamId: teamID,
      certificateId: certificateID,
      type: 'WXV89964HE',
    },
  } satisfies AppleProvisioningRequest;
}

export function createDevelopmentProfileRequest({
  bundleID,
  teamID = '',
  appIDID,
  certificateID,
  deviceIDs,
  name,
}: Pick<AppleProvisioningContext, 'bundleID' | 'teamID'> & {
  appIDID: string;
  certificateID: string;
  deviceIDs: string[];
  name?: string;
}) {
  return {
    method: 'POST',
    path: '/account/ios/profile/createProvisioningProfile.action',
    payload: {
      teamId: teamID,
      provisioningProfileName: name ?? `Limrun ${bundleID}`,
      certificateIds: [certificateID],
      appIdId: appIDID,
      deviceIds: deviceIDs,
      distributionType: 'limited',
      subPlatform: 'ios',
    },
  } satisfies AppleProvisioningRequest;
}

export function createAdHocProfileRequest({
  bundleID,
  teamID = '',
  appIDID,
  certificateID,
  deviceIDs,
  name,
}: Pick<AppleProvisioningContext, 'bundleID' | 'teamID'> & {
  appIDID: string;
  certificateID: string;
  deviceIDs: string[];
  name?: string;
}) {
  return {
    method: 'POST',
    path: '/account/ios/profile/createProvisioningProfile.action',
    payload: {
      teamId: teamID,
      provisioningProfileName: name ?? `Limrun Ad Hoc ${bundleID}`,
      certificateIds: [certificateID],
      appIdId: appIDID,
      deviceIds: deviceIDs,
      distributionType: 'adhoc',
      subPlatform: 'ios',
    },
  } satisfies AppleProvisioningRequest;
}

export function downloadProfileRequest(profileID: string, teamID = '') {
  return {
    method: 'GET',
    path: '/account/ios/profile/downloadProfileContent',
    payload: {
      teamId: teamID,
      provisioningProfileId: profileID,
    },
  } satisfies AppleProvisioningRequest;
}

export async function getReusableAppleSigningAssets({
  bundleID,
  deviceUDID,
  teamID,
  signingMode,
}: AppleSigningAssetCacheInput) {
  const stored = await getSigningAssets({ bundleID, deviceUDID, signingMode });
  if (!stored || !storedSigningAssetsReusable(stored, { bundleID, deviceUDID, teamID, signingMode })) {
    return undefined;
  }
  return stored;
}

export async function putAppleGeneratedSigningAssets(input: PutAppleGeneratedSigningAssetsInput) {
  return putSigningAssets({
    ...input,
    certificateFileName:
      input.certificateID ? `${input.certificateID}.p12` : `apple-${input.signingMode ?? 'development'}.p12`,
    certificatePassword: input.certificatePassword || undefined,
    signingMode: input.signingMode,
    profileFileName:
      input.profile.uuid ?
        `${input.profile.uuid}.mobileprovision`
      : `${input.signingMode ?? 'development'}.mobileprovision`,
  });
}

export function storedSigningAssetsReusable(
  stored: StoredSigningAssets,
  { bundleID, deviceUDID, teamID, signingMode = 'development' }: AppleSigningAssetCacheInput,
) {
  if ((stored.signingMode ?? 'development') !== signingMode) {
    return false;
  }
  if (!profileMatchesBundleID(stored.profile, bundleID)) {
    return false;
  }
  if (teamID && stored.teamID && stored.teamID !== teamID) {
    return false;
  }
  if (deviceUDID && !profileContainsDevice(stored.profile, deviceUDID)) {
    return false;
  }
  if (stored.profile.expirationDate && new Date(stored.profile.expirationDate).getTime() <= Date.now()) {
    return false;
  }
  return normalizeBundleID(stored.bundleID) === normalizeBundleID(bundleID);
}

export function selectDeveloperPortalTeam(body: unknown): AppleDeveloperPortalTeam | undefined {
  const response = body as AppleDeveloperPortalResponse | undefined;
  return response?.teams?.[0] ?? response?.provider ?? response?.availableProviders?.[0];
}

export function teamIDCandidates(body: unknown): string[] {
  const response = body as AppleDeveloperPortalResponse | undefined;
  const teams = [
    ...(response?.teams ?? []),
    ...(response?.provider ? [response.provider] : []),
    ...(response?.availableProviders ?? []),
  ];
  const ids = new Set<string>();
  for (const team of teams) {
    for (const value of [team.teamId, team.providerId, team.publicProviderId]) {
      if (value !== undefined && value !== '') {
        ids.add(String(value));
      }
    }
  }
  return [...ids];
}

function pagedRequest(path: string, teamID: string, payload: Record<string, unknown> = {}) {
  const basePayload: Record<string, unknown> = {
    pageNumber: 1,
    pageSize: 200,
    ...payload,
  };
  if (teamID) {
    basePayload.teamId = teamID;
  }
  return {
    method: 'POST',
    path,
    payload: basePayload,
  } satisfies AppleProvisioningRequest;
}
