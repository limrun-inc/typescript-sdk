import type { ApplePlatformScopedOptions, AppleTeamScopedOptions } from './portal';
import {
  portalRequest,
  portalDownload,
  paged,
  PORTAL_PAGE_SIZE,
  type PortalEnvelope,
} from './internal/portal';

/** Portal records retain Apple's field names, including opaque IDs used for assignments. */
export type ApplePortalIdentifier = {
  identifier: string;
  name?: string;
  prefix?: string;
  status?: string;
};
export type AppleAppGroup = ApplePortalIdentifier & { applicationGroup: string };
export type AppleCloudContainer = ApplePortalIdentifier & { cloudContainer: string };
export type AppleMerchantID = ApplePortalIdentifier & { omcId: string };
export type ApplePassTypeID = ApplePortalIdentifier & { passTypeId: string };
export type AppleWebsitePushID = ApplePortalIdentifier & { websitePushId: string };
export type AppleMerchantDomain = {
  displayId: string;
  name?: string;
  status?: string;
  path?: string;
  canVerify?: boolean;
  expirationDate?: string;
};
export type AppleDeveloperKey = {
  keyId: string;
  keyName?: string;
  services?: Array<Record<string, unknown>>;
  canDownload?: boolean;
  canRevoke?: boolean;
};
export type AppleBundleIDDetails = {
  appIdId: string;
  identifier: string;
  name?: string;
  features?: Record<string, unknown>;
  enabledFeatures?: unknown;
  associatedApplicationGroups?: AppleAppGroup[];
  associatedCloudContainers?: AppleCloudContainer[];
  [key: string]: unknown;
};
export type AppleProfileDetails = {
  provisioningProfileId: string;
  name?: string;
  appId?: AppleBundleIDDetails;
  [key: string]: unknown;
};

type ResourceResponse = PortalEnvelope & {
  applicationGroupList?: AppleAppGroup[];
  applicationGroup?: AppleAppGroup;
  cloudContainerList?: AppleCloudContainer[];
  cloudContainer?: AppleCloudContainer;
  identifierList?: AppleMerchantID[];
  omcId?: AppleMerchantID;
  passTypeIdList?: ApplePassTypeID[];
  passTypeId?: ApplePassTypeID;
  websitePushIdList?: AppleWebsitePushID[];
  websitePushId?: AppleWebsitePushID;
  domainList?: AppleMerchantDomain[];
  keys?: AppleDeveloperKey[];
  appId?: AppleBundleIDDetails;
  provisioningProfile?: AppleProfileDetails;
};

async function listResources<K extends keyof ResourceResponse>(
  { relay, teamId = '' }: AppleTeamScopedOptions,
  path: string,
  key: K,
): Promise<NonNullable<ResourceResponse[K]>> {
  const records: unknown[] = [];
  let previousPage: string | undefined;
  for (let pageNumber = 1; ; pageNumber++) {
    const body = await portalRequest<ResourceResponse>(
      relay,
      paged(path, teamId, { pageNumber }),
      'Apple resource list',
    );
    const page = body[key];
    if (!Array.isArray(page)) throw new Error(`Apple resource list did not return ${String(key)}.`);
    const fingerprint = JSON.stringify(page);
    if (page.length && fingerprint === previousPage) throw new Error('Apple resource list repeated a page.');
    previousPage = fingerprint;
    records.push(...page);
    if (page.length < PORTAL_PAGE_SIZE) return records as NonNullable<ResourceResponse[K]>;
  }
}

// Apple issues CSRF headers on list requests. Refresh them for the resource being changed.
async function primeResource({ relay, teamId = '' }: AppleTeamScopedOptions, path: string) {
  await portalRequest(relay, paged(path, teamId, { pageSize: 1 }), 'Apple resource session');
}

function requiredRecord<T>(record: T | undefined, label: string): T {
  if (!record) throw new Error(`${label} returned no record.`);
  return record;
}

export type AppleIdentifierInput = { identifier: string; name?: string };

export async function listAppleAppGroups(options: AppleTeamScopedOptions): Promise<AppleAppGroup[]> {
  return listResources(
    options,
    `/account/ios/identifiers/listApplicationGroups.action`,
    'applicationGroupList',
  );
}

export type CreateAppleAppGroupOptions = AppleTeamScopedOptions & AppleIdentifierInput;
export async function createAppleAppGroup(options: CreateAppleAppGroupOptions): Promise<AppleAppGroup> {
  const { relay, teamId = '', identifier, name = identifier } = options;

  await primeResource(options, `/account/ios/identifiers/listApplicationGroups.action`);
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/ios/identifiers/addApplicationGroup.action`,
      payload: { teamId, name, identifier },
    },
    'Apple App Group creation',
  );
  return requiredRecord(body.applicationGroup, 'Apple App Group creation');
}

export type DeleteAppleAppGroupOptions = AppleTeamScopedOptions & { applicationGroup: string };
export async function deleteAppleAppGroup(options: DeleteAppleAppGroupOptions): Promise<void> {
  const { relay, teamId = '', applicationGroup } = options;

  await primeResource(options, `/account/ios/identifiers/listApplicationGroups.action`);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: `/account/ios/identifiers/deleteApplicationGroup.action`,
      payload: { teamId, applicationGroup },
    },
    'Apple App Group deletion',
  );
}

export async function listAppleCloudContainers(
  options: AppleTeamScopedOptions,
): Promise<AppleCloudContainer[]> {
  return listResources(options, `/account/cloudContainer/listCloudContainers.action`, 'cloudContainerList');
}

export type CreateAppleCloudContainerOptions = AppleTeamScopedOptions & AppleIdentifierInput;
export async function createAppleCloudContainer(
  options: CreateAppleCloudContainerOptions,
): Promise<AppleCloudContainer> {
  const { relay, teamId = '', identifier, name = identifier } = options;

  await primeResource(options, `/account/cloudContainer/listCloudContainers.action`);
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/cloudContainer/addCloudContainer.action`,
      payload: { teamId, name, identifier },
    },
    'Apple iCloud container creation',
  );
  return requiredRecord(body.cloudContainer, 'Apple iCloud container creation');
}

export async function listAppleMerchantIDs(options: ApplePlatformScopedOptions): Promise<AppleMerchantID[]> {
  const { platform = 'ios' } = options;
  return listResources(options, `/account/${platform}/identifiers/listOMCs.action`, 'identifierList');
}

export type CreateAppleMerchantIDOptions = ApplePlatformScopedOptions & AppleIdentifierInput;
export async function createAppleMerchantID(options: CreateAppleMerchantIDOptions): Promise<AppleMerchantID> {
  const { relay, teamId = '', identifier, name = identifier } = options;
  const { platform = 'ios' } = options;
  await primeResource(options, `/account/${platform}/identifiers/listOMCs.action`);
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/addOMC.action`,
      payload: { teamId, name, identifier },
    },
    'Apple merchant ID creation',
  );
  return requiredRecord(body.omcId, 'Apple merchant ID creation');
}

export type DeleteAppleMerchantIDOptions = ApplePlatformScopedOptions & { omcId: string };
export async function deleteAppleMerchantID(options: DeleteAppleMerchantIDOptions): Promise<void> {
  const { relay, teamId = '', omcId } = options;
  const { platform = 'ios' } = options;
  await primeResource(options, `/account/${platform}/identifiers/listOMCs.action`);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/deleteOMC.action`,
      payload: { teamId, omcId },
    },
    'Apple merchant ID deletion',
  );
}

export async function listApplePassTypeIDs(options: AppleTeamScopedOptions): Promise<ApplePassTypeID[]> {
  return listResources(options, `/account/ios/identifiers/listPassTypeIds.action`, 'passTypeIdList');
}

export type CreateApplePassTypeIDOptions = AppleTeamScopedOptions & AppleIdentifierInput;
export async function createApplePassTypeID(options: CreateApplePassTypeIDOptions): Promise<ApplePassTypeID> {
  const { relay, teamId = '', identifier, name = identifier } = options;

  await primeResource(options, `/account/ios/identifiers/listPassTypeIds.action`);
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/ios/identifiers/addPassTypeId.action`,
      payload: { teamId, name, identifier },
    },
    'Apple pass type ID creation',
  );
  return requiredRecord(body.passTypeId, 'Apple pass type ID creation');
}

export type DeleteApplePassTypeIDOptions = AppleTeamScopedOptions & { passTypeId: string };
export async function deleteApplePassTypeID(options: DeleteApplePassTypeIDOptions): Promise<void> {
  const { relay, teamId = '', passTypeId } = options;

  await primeResource(options, `/account/ios/identifiers/listPassTypeIds.action`);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: `/account/ios/identifiers/deletePassTypeId.action`,
      payload: { teamId, passTypeId },
    },
    'Apple pass type ID deletion',
  );
}

export async function listAppleWebsitePushIDs(
  options: ApplePlatformScopedOptions,
): Promise<AppleWebsitePushID[]> {
  const { platform = 'ios' } = options;
  return listResources(
    options,
    `/account/${platform}/identifiers/listWebsitePushIds.action`,
    'websitePushIdList',
  );
}

export type CreateAppleWebsitePushIDOptions = ApplePlatformScopedOptions & AppleIdentifierInput;
export async function createAppleWebsitePushID(
  options: CreateAppleWebsitePushIDOptions,
): Promise<AppleWebsitePushID> {
  const { relay, teamId = '', identifier, name = identifier } = options;
  const { platform = 'ios' } = options;
  await primeResource(options, `/account/${platform}/identifiers/listWebsitePushIds.action`);
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/addWebsitePushId.action`,
      payload: { teamId, name, identifier },
    },
    'Apple website push ID creation',
  );
  return requiredRecord(body.websitePushId, 'Apple website push ID creation');
}

export type DeleteAppleWebsitePushIDOptions = ApplePlatformScopedOptions & { websitePushId: string };
export async function deleteAppleWebsitePushID(options: DeleteAppleWebsitePushIDOptions): Promise<void> {
  const { relay, teamId = '', websitePushId } = options;
  const { platform = 'ios' } = options;
  await primeResource(options, `/account/${platform}/identifiers/listWebsitePushIds.action`);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/deleteWebsitePushId.action`,
      payload: { teamId, websitePushId },
    },
    'Apple website push ID deletion',
  );
}

export async function ensureAppleAppGroup(options: CreateAppleAppGroupOptions): Promise<AppleAppGroup> {
  const existing = (await listAppleAppGroups(options)).find(
    (group) => group.identifier === options.identifier,
  );
  return existing ?? createAppleAppGroup(options);
}

export type GetAppleBundleIDDetailsOptions = ApplePlatformScopedOptions & { appIdId: string };
export async function getAppleBundleIDDetails({
  relay,
  teamId = '',
  platform = 'ios',
  appIdId,
}: GetAppleBundleIDDetailsOptions): Promise<AppleBundleIDDetails> {
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/getAppIdDetail.action`,
      payload: { teamId, appIdId },
    },
    'Apple bundle ID details',
  );
  return requiredRecord(body.appId, 'Apple bundle ID details');
}

export type RenameAppleBundleIDOptions = GetAppleBundleIDDetailsOptions & { name: string };
export async function renameAppleBundleID(
  options: RenameAppleBundleIDOptions,
): Promise<AppleBundleIDDetails> {
  const { relay, teamId = '', platform = 'ios', appIdId, name } = options;
  await primeResource(options, `/account/${platform}/identifiers/listAppIds.action`);
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/updateAppIdName.action`,
      payload: { teamId, appIdId, name },
    },
    'Apple bundle ID rename',
  );
  return requiredRecord(body.appId, 'Apple bundle ID rename');
}

export type UpdateAppleAppServiceOptions = AppleTeamScopedOptions & {
  appIdId: string;
  /** Apple's service ID, for example APG3427HIY for App Groups or push for notifications. */
  featureType: string;
  featureValue: string | boolean;
};
/** Applies one capability setting without replacing unrelated capabilities. */
export async function updateAppleAppService(options: UpdateAppleAppServiceOptions): Promise<void> {
  const { relay, teamId = '', appIdId, featureType, featureValue } = options;
  await primeResource(options, '/account/ios/identifiers/listAppIds.action');
  await portalRequest(
    relay,
    {
      method: 'POST',
      path:
        featureType === 'push' ?
          '/account/ios/identifiers/updatePushService.action'
        : '/account/ios/identifiers/updateService.action',
      payload: { teamId, displayId: appIdId, featureType, featureValue },
    },
    'Apple capability update',
  );
}

export type AssignAppleAppGroupsOptions = AppleTeamScopedOptions & {
  appIdId: string;
  /** Complete desired assignment set of opaque applicationGroup IDs. Read details before adding to an existing set. */
  applicationGroups: string[];
};
/** Sends the supplied set as-is; does not merge assignments or regenerate profiles. */
export async function assignAppleAppGroups(options: AssignAppleAppGroupsOptions): Promise<void> {
  const { relay, teamId = '', appIdId, applicationGroups } = options;
  await primeResource(options, '/account/ios/identifiers/listApplicationGroups.action');
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/identifiers/assignApplicationGroupToAppId.action',
      payload: { teamId, appIdId, displayId: appIdId, applicationGroups },
    },
    'Apple App Group assignment',
  );
}

export type AssignAppleCloudContainersOptions = AppleTeamScopedOptions & {
  appIdId: string;
  cloudContainers: string[];
};
/** Sends the complete desired set of opaque cloudContainer IDs. */
export async function assignAppleCloudContainers(options: AssignAppleCloudContainersOptions): Promise<void> {
  const { relay, teamId = '', appIdId, cloudContainers } = options;
  await primeResource(options, '/account/cloudContainer/listCloudContainers.action');
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/ios/identifiers/assignCloudContainerToAppId.action',
      payload: { teamId, appIdId, cloudContainers },
    },
    'Apple iCloud container assignment',
  );
}

export type AssignAppleMerchantIDsOptions = ApplePlatformScopedOptions & {
  appIdId: string;
  omcIds: string[];
};
/** Sends the complete desired set of opaque omcId IDs. */
export async function assignAppleMerchantIDs(options: AssignAppleMerchantIDsOptions): Promise<void> {
  const { relay, teamId = '', platform = 'ios', appIdId, omcIds } = options;
  await primeResource(options, `/account/${platform}/identifiers/listOMCs.action`);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/assignOMCToAppId.action`,
      payload: { teamId, appIdId, omcIds },
    },
    'Apple merchant assignment',
  );
}

export type EnableAppleDeviceOptions = ApplePlatformScopedOptions & { deviceId: string; deviceUDID: string };
export async function enableAppleDevice({
  relay,
  teamId = '',
  platform = 'ios',
  deviceId,
  deviceUDID,
}: EnableAppleDeviceOptions) {
  return portalRequest(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/device/enableDevice.action`,
      payload: { teamId, displayId: deviceId, deviceNumber: deviceUDID },
    },
    'Apple device enable',
  );
}

export type GetAppleProfileDetailsOptions = ApplePlatformScopedOptions & { profileId: string };
export async function getAppleProfileDetails({
  relay,
  teamId = '',
  platform = 'ios',
  profileId,
}: GetAppleProfileDetailsOptions): Promise<AppleProfileDetails> {
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/profile/getProvisioningProfile.action`,
      payload: { teamId, provisioningProfileId: profileId },
    },
    'Apple profile details',
  );
  return requiredRecord(body.provisioningProfile, 'Apple profile details');
}

export type RegenerateAppleProfileOptions = GetAppleProfileDetailsOptions & {
  name: string;
  appIdId: string;
  distributionType: 'limited' | 'adhoc' | 'store' | 'inhouse' | 'direct';
  certificateIds: string[];
  /** Required and nonempty for development (limited) and ad hoc profiles. Includes every device to retain. */
  deviceIds?: string[];
  subPlatform?: string;
  template?: string;
};
export async function regenerateAppleProfile(
  options: RegenerateAppleProfileOptions,
): Promise<AppleProfileDetails> {
  const {
    relay,
    teamId = '',
    platform = 'ios',
    profileId,
    name,
    appIdId,
    distributionType,
    certificateIds,
    deviceIds = [],
    subPlatform,
    template,
  } = options;
  if (!certificateIds.length)
    throw new Error('At least one certificate ID is required to regenerate an Apple provisioning profile.');
  if ((distributionType === 'limited' || distributionType === 'adhoc') && !deviceIds.length) {
    throw new Error(
      'At least one device ID is required to regenerate a development or ad hoc provisioning profile.',
    );
  }
  await primeResource(options, `/account/${platform}/profile/listProvisioningProfiles.action`);
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/profile/regenProvisioningProfile.action`,
      payload: {
        teamId,
        provisioningProfileId: profileId,
        provisioningProfileName: name,
        appIdId,
        distributionType,
        certificateIds: certificateIds.join(','),
        deviceIds,
        ...(subPlatform ? { subPlatform } : {}),
        ...(template ? { template } : {}),
      },
    },
    'Apple profile regeneration',
  );
  return requiredRecord(body.provisioningProfile, 'Apple profile regeneration');
}

export type ListAppleMerchantDomainsOptions = ApplePlatformScopedOptions & { merchantId: string };
export async function listAppleMerchantDomains({
  relay,
  teamId = '',
  platform = 'ios',
  merchantId,
}: ListAppleMerchantDomainsOptions): Promise<AppleMerchantDomain[]> {
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/listDomainsForMerchant`,
      payload: { teamId, merchantId },
    },
    'Apple merchant domains',
  );
  return requiredRecord(body.domainList, 'Apple merchant domains');
}

export type RegisterAppleMerchantDomainOptions = ListAppleMerchantDomainsOptions & { domainName: string };
export async function registerAppleMerchantDomain(
  options: RegisterAppleMerchantDomainOptions,
): Promise<AppleMerchantDomain> {
  const { relay, teamId = '', platform = 'ios', merchantId, domainName } = options;
  await primeResource(options, `/account/${platform}/identifiers/listOMCs.action`);
  const body = await portalRequest<ResourceResponse>(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/registerDomain`,
      payload: { teamId, merchantId, domainName },
    },
    'Apple merchant domain registration',
  );
  return requiredRecord(body.domainList?.[0], 'Apple merchant domain registration');
}

export type AppleMerchantDomainOptions = ApplePlatformScopedOptions & { domainId: string };
/** Returns the downloaded verification file in rawBodyBase64. */
export async function downloadAppleMerchantDomainVerification({
  relay,
  teamId = '',
  platform = 'ios',
  domainId,
}: AppleMerchantDomainOptions) {
  return portalDownload(relay, {
    method: 'GET',
    path: `/account/${platform}/identifiers/downloadDomainVerificationFile`,
    payload: { teamId, domainId },
  });
}

export async function verifyAppleMerchantDomain(options: AppleMerchantDomainOptions): Promise<void> {
  const { relay, teamId = '', platform = 'ios', domainId } = options;
  await primeResource(options, `/account/${platform}/identifiers/listOMCs.action`);
  await portalRequest(
    relay,
    { method: 'POST', path: `/account/${platform}/identifiers/verifyDomain`, payload: { teamId, domainId } },
    'Apple merchant domain verification',
  );
}

export type DeleteAppleMerchantDomainOptions = AppleMerchantDomainOptions & { merchantId: string };
export async function deleteAppleMerchantDomain(options: DeleteAppleMerchantDomainOptions): Promise<void> {
  const { relay, teamId = '', platform = 'ios', merchantId, domainId } = options;
  await primeResource(options, `/account/${platform}/identifiers/listOMCs.action`);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: `/account/${platform}/identifiers/removeDomain`,
      payload: { teamId, merchantId, domainId },
    },
    'Apple merchant domain deletion',
  );
}

/** Developer Portal keys are separate from App Store Connect API keys. */
export async function listAppleDeveloperKeys(options: AppleTeamScopedOptions): Promise<AppleDeveloperKey[]> {
  return listResources(options, '/account/auth/key/list', 'keys');
}
export type AppleDeveloperKeyOptions = AppleTeamScopedOptions & { keyId: string };
export async function getAppleDeveloperKey({
  relay,
  teamId = '',
  keyId,
}: AppleDeveloperKeyOptions): Promise<AppleDeveloperKey> {
  const body = await portalRequest<ResourceResponse>(
    relay,
    { method: 'POST', path: '/account/auth/key/get', payload: { teamId, keyId } },
    'Apple Developer key details',
  );
  return requiredRecord(body.keys?.[0], 'Apple Developer key details');
}
/** Returns private key bytes in rawBodyBase64. Apple's download may be available only once. */
export async function downloadAppleDeveloperKey({ relay, teamId = '', keyId }: AppleDeveloperKeyOptions) {
  return portalDownload(relay, {
    method: 'GET',
    path: '/account/auth/key/download',
    payload: { teamId, keyId },
  });
}
export async function revokeAppleDeveloperKey(options: AppleDeveloperKeyOptions): Promise<void> {
  const { relay, teamId = '', keyId } = options;
  await primeResource(options, '/account/auth/key/list');
  await portalRequest(
    relay,
    { method: 'POST', path: '/account/auth/key/revoke', payload: { teamId, keyId } },
    'Apple Developer key revocation',
  );
}
