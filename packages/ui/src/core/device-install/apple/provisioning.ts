import type { ProvisioningProfileInfo, StoredSigningAssets } from '../types';
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

export type AppleDeveloperPortalResponse = {
  teams?: AppleDeveloperPortalTeam[];
  provider?: AppleDeveloperPortalTeam;
  availableProviders?: AppleDeveloperPortalTeam[];
  appIds?: Array<Record<string, unknown>>;
  devices?: Array<Record<string, unknown>>;
  certRequests?: Array<Record<string, unknown>>;
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
};

export type PutAppleGeneratedSigningAssetsInput = {
  bundleID: string;
  deviceUDID?: string;
  teamID?: string;
  certificateID?: string;
  certificateP12Base64: string;
  certificatePassword: string;
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

export function findBundleIDRequest({ bundleID, teamID = '' }: Pick<AppleProvisioningContext, 'bundleID' | 'teamID'>) {
  return pagedRequest('/account/ios/identifiers/listAppIds.action', teamID, { search: bundleID });
}

export function findDeviceRequest({ deviceUDID, teamID = '' }: Pick<AppleProvisioningContext, 'deviceUDID' | 'teamID'>) {
  return pagedRequest('/account/ios/device/listDevices.action', teamID, { search: normalizeUDID(deviceUDID) });
}

export function findDevelopmentCertificatesRequest(teamID = '') {
  return pagedRequest('/account/ios/certificate/listCertRequests.action', teamID);
}

export function findDevelopmentProfilesRequest({
  bundleID,
  teamID = '',
}: Pick<AppleProvisioningContext, 'bundleID' | 'teamID'>) {
  return pagedRequest('/account/ios/profile/listProvisioningProfiles.action', teamID, { search: bundleID });
}

export function registerDeviceRequest({
  deviceUDID,
  teamID = '',
  name = 'Limrun iPhone',
}: AppleProvisioningContext & { name?: string }) {
  return {
    method: 'POST',
    path: '/account/ios/device/addDevice.action',
    payload: {
      teamId: teamID,
      name,
      deviceNumber: normalizeUDID(deviceUDID),
      deviceClass: 'iphone',
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

export function submitDevelopmentCSRRequest({
  csrPEM,
  teamID = '',
}: {
  csrPEM: string;
  teamID?: string;
}) {
  return {
    method: 'POST',
    path: '/account/ios/certificate/submitDevelopmentCSR.action',
    payload: {
      teamId: teamID,
      csrContent: csrPEM,
    },
  } satisfies AppleProvisioningRequest;
}

export function downloadCertificateRequest(certificateID: string, teamID = '') {
  return {
    method: 'POST',
    path: '/account/ios/certificate/downloadCertificateContent.action',
    payload: {
      teamId: teamID,
      certificateId: certificateID,
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
      appIdId: appIDID,
      certificateIds: [certificateID],
      deviceIds: deviceIDs,
      distributionMethod: 'development',
      name: name ?? `Limrun ${bundleID}`,
      subPlatform: 'ios',
    },
  } satisfies AppleProvisioningRequest;
}

export function downloadProfileRequest(profileID: string, teamID = '') {
  return {
    method: 'POST',
    path: '/account/ios/profile/downloadProfileContent.action',
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
}: AppleSigningAssetCacheInput) {
  const stored = await getSigningAssets({ bundleID, deviceUDID });
  if (!stored || !storedSigningAssetsReusable(stored, { bundleID, deviceUDID, teamID })) {
    return undefined;
  }
  return stored;
}

export async function putAppleGeneratedSigningAssets(input: PutAppleGeneratedSigningAssetsInput) {
  return putSigningAssets({
    ...input,
    certificateFileName: input.certificateID ? `${input.certificateID}.p12` : 'apple-development.p12',
    profileFileName: input.profile.uuid ? `${input.profile.uuid}.mobileprovision` : 'apple-development.mobileprovision',
  });
}

export function storedSigningAssetsReusable(
  stored: StoredSigningAssets,
  { bundleID, deviceUDID, teamID }: AppleSigningAssetCacheInput,
) {
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
  return {
    method: 'POST',
    path,
    payload: {
      pageNumber: 1,
      pageSize: 200,
      teamId: teamID,
      ...payload,
    },
  } satisfies AppleProvisioningRequest;
}
