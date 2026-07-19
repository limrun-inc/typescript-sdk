import {
  createAdHocProfileRequest,
  createBundleIDRequest,
  createDevelopmentProfileRequest,
  downloadCertificateRequest,
  downloadDistributionCertificateRequest,
  downloadProfileRequest,
  findAdHocProfilesRequest,
  findBundleIDRequest,
  findDevelopmentCertificatesRequest,
  findDevelopmentProfilesRequest,
  findDeviceRequest,
  findDistributionCertificatesRequest,
  listTeamsRequest,
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
} from '../core/device-install/apple';
export {
  AppleRelayWebSocketClient,
  fetchAppleAccountSession,
  openAppleRelayWebSocket,
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

export type AppleProfileKind = 'development' | 'adhoc';

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
  bundleId?: string;
};

export type CreateAppleProfileOptions = AppleTeamScopedOptions & {
  profileKind?: AppleProfileKind;
  bundleId: string;
  appIdId: string;
  certificateIds: string[];
  deviceIds: string[];
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
  return requestAppleProvisioning<Array<Record<string, unknown>>>({
    ...options,
    request:
      profileKind === 'adhoc' ?
        findAdHocProfilesRequest({ bundleID: bundleId, teamID: teamId })
      : findDevelopmentProfilesRequest({ bundleID: bundleId, teamID: teamId }),
    label: 'Apple provisioning profile list',
    mapBody: (body) => body?.provisioningProfiles ?? [],
  });
}

export async function createAppleProfile({
  profileKind = 'development',
  teamId = '',
  bundleId,
  appIdId,
  certificateIds,
  deviceIds,
  name,
  ...options
}: CreateAppleProfileOptions) {
  const [certificateId] = certificateIds;
  if (!certificateId) {
    throw new Error('At least one certificate ID is required to create an Apple provisioning profile.');
  }
  return requestAppleProvisioning<Record<string, unknown> | undefined>({
    ...options,
    request:
      profileKind === 'adhoc' ?
        createAdHocProfileRequest({
          bundleID: bundleId,
          teamID: teamId,
          appIDID: appIdId,
          certificateID: certificateId,
          deviceIDs: deviceIds,
          name,
        })
      : createDevelopmentProfileRequest({
          bundleID: bundleId,
          teamID: teamId,
          appIDID: appIdId,
          certificateID: certificateId,
          deviceIDs: deviceIds,
          name,
        }),
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
