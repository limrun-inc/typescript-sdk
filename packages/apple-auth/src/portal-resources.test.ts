// @vitest-environment node
import { describe, expect, test, vi } from 'vitest';
import type { AppleRelayWebSocketClient } from './relay';
import * as resources from './portal-resources';
import * as portal from './portal';

const group = { applicationGroup: 'GROUP', identifier: 'group.com.example.shared', name: 'Shared' };
const cloud = { cloudContainer: 'CLOUD', identifier: 'iCloud.com.example.app' };
const merchant = { omcId: 'MERCHANT', identifier: 'merchant.com.example.app' };
const pass = { passTypeId: 'PASS', identifier: 'pass.com.example.app' };
const website = { websitePushId: 'WEB', identifier: 'web.com.example.app' };
const domain = { displayId: 'DOMAIN', name: 'example.com' };
const app = { appIdId: 'APP', identifier: 'com.example.app', associatedApplicationGroups: [group] };
const profile = { provisioningProfileId: 'PROFILE', name: 'App', appId: app };
const key = { keyId: 'KEY', keyName: 'Notifications', canDownload: true };
function relayReturning(body: Record<string, unknown> = {}) {
  const request = vi
    .fn()
    .mockResolvedValue({ status: 200, statusText: 'OK', body: { resultCode: 0, ...body } });
  return { request } as unknown as AppleRelayWebSocketClient & { request: typeof request };
}
const base = { teamId: 'TEAM' };

describe('portal resource contract', () => {
  test('normalizes neither the opaque group ID nor its entitlement identifier', async () => {
    const relay = relayReturning({ applicationGroupList: [group] });
    await expect(
      resources.ensureAppleAppGroup({ relay, ...base, identifier: group.identifier }),
    ).resolves.toEqual(group);
    expect(relay.request).toHaveBeenCalledTimes(1);
    expect(relay.request).toHaveBeenCalledWith('provisioning', {
      method: 'POST',
      path: '/account/ios/identifiers/listApplicationGroups.action',
      payload: { teamId: 'TEAM', pageNumber: 1, pageSize: 200, sort: 'name=asc' },
    });
  });

  test('creates a missing group after refreshing its CSRF headers', async () => {
    const relay = relayReturning({ applicationGroupList: [], applicationGroup: group });
    await expect(
      resources.ensureAppleAppGroup({ relay, ...base, identifier: group.identifier, name: 'Shared' }),
    ).resolves.toEqual(group);
    expect(relay.request.mock.calls.map((call) => call[1])).toEqual([
      {
        method: 'POST',
        path: '/account/ios/identifiers/listApplicationGroups.action',
        payload: { teamId: 'TEAM', pageNumber: 1, pageSize: 200, sort: 'name=asc' },
      },
      {
        method: 'POST',
        path: '/account/ios/identifiers/listApplicationGroups.action',
        payload: { teamId: 'TEAM', pageNumber: 1, pageSize: 1, sort: 'name=asc' },
      },
      {
        method: 'POST',
        path: '/account/ios/identifiers/addApplicationGroup.action',
        payload: { teamId: 'TEAM', identifier: group.identifier, name: 'Shared' },
      },
    ]);
  });

  test('reads more than one page and keeps team and sort on every request', async () => {
    const firstPage = Array.from({ length: 200 }, (_, n) => ({
      applicationGroup: `GROUP${n}`,
      identifier: `group.example.${n}`,
    }));
    const relay = relayReturning({ applicationGroupList: [group] });
    relay.request.mockResolvedValueOnce({
      status: 200,
      body: { resultCode: 0, applicationGroupList: firstPage },
    });
    await expect(resources.listAppleAppGroups({ relay, ...base })).resolves.toEqual([...firstPage, group]);
    expect(relay.request.mock.calls[1][1].payload).toEqual({
      teamId: 'TEAM',
      pageNumber: 2,
      pageSize: 200,
      sort: 'name=asc',
    });
  });

  test('fails if Apple ignores the page number rather than looping forever', async () => {
    const relay = relayReturning({ applicationGroupList: Array.from({ length: 200 }, () => group) });
    await expect(resources.listAppleAppGroups({ relay, ...base })).rejects.toThrow('repeated a page');
    expect(relay.request).toHaveBeenCalledTimes(2);
  });

  test('can preserve an existing association while adding the shared group to both bundles', async () => {
    const relay = relayReturning({
      appId: { ...app, associatedApplicationGroups: [{ ...group, applicationGroup: 'EXISTING' }] },
    });
    for (const appIdId of ['MAIN', 'WIDGET']) {
      const details = await resources.getAppleBundleIDDetails({ relay, ...base, appIdId });
      await resources.assignAppleAppGroups({
        relay,
        ...base,
        appIdId,
        applicationGroups: [
          ...(details.associatedApplicationGroups ?? []).map((g) => g.applicationGroup),
          group.applicationGroup,
        ],
      });
    }
    const assignments = relay.request.mock.calls.filter((call) =>
      call[1].path.endsWith('assignApplicationGroupToAppId.action'),
    );
    expect(assignments.map((call) => call[1].payload)).toEqual(
      ['MAIN', 'WIDGET'].map((appIdId) => ({
        teamId: 'TEAM',
        appIdId,
        displayId: appIdId,
        applicationGroups: ['EXISTING', 'GROUP'],
      })),
    );
  });

  test.each(['APG3427HIY', 'push'])(
    'updates capability %s with its correct endpoint',
    async (featureType) => {
      const relay = relayReturning();
      await resources.updateAppleAppService({
        relay,
        ...base,
        appIdId: 'APP',
        featureType,
        featureValue: true,
      });
      expect(relay.request.mock.calls.at(-1)).toEqual([
        'provisioning',
        {
          method: 'POST',
          path: `/account/ios/identifiers/${
            featureType === 'push' ? 'updatePushService' : 'updateService'
          }.action`,
          payload: { teamId: 'TEAM', displayId: 'APP', featureType, featureValue: true },
        },
      ]);
    },
  );

  test('regeneration sends all certificates as a comma-separated value', async () => {
    const relay = relayReturning({ provisioningProfile: profile });
    await expect(
      resources.regenerateAppleProfile({
        relay,
        ...base,
        platform: 'mac',
        profileId: 'PROFILE',
        appIdId: 'APP',
        name: 'App',
        distributionType: 'direct',
        certificateIds: ['CERT1', 'CERT2'],
        deviceIds: ['DEVICE'],
        template: 'Custom',
      }),
    ).resolves.toEqual(profile);
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path: '/account/mac/profile/regenProvisioningProfile.action',
      payload: {
        teamId: 'TEAM',
        provisioningProfileId: 'PROFILE',
        appIdId: 'APP',
        provisioningProfileName: 'App',
        distributionType: 'direct',
        certificateIds: 'CERT1,CERT2',
        deviceIds: ['DEVICE'],
        template: 'Custom',
      },
    });
  });

  describe.each(['ios', 'mac'] as const)('profile regeneration on %s', (platform) => {
    const options = {
      ...base,
      platform,
      profileId: 'PROFILE',
      appIdId: 'APP',
      name: 'App',
      certificateIds: ['CERT'],
    };

    test.each(['limited', 'adhoc'] as const)(
      'rejects missing devices for %s before any request',
      async (distributionType) => {
        for (const deviceIds of [undefined, []]) {
          const relay = relayReturning({ provisioningProfile: profile });
          await expect(
            resources.regenerateAppleProfile({ relay, ...options, distributionType, deviceIds }),
          ).rejects.toThrow('At least one device ID');
          expect(relay.request).not.toHaveBeenCalled();
        }
      },
    );

    test.each(['limited', 'adhoc'] as const)(
      'preserves the explicit device list for %s',
      async (distributionType) => {
        const relay = relayReturning({ provisioningProfile: profile });
        await expect(
          resources.regenerateAppleProfile({
            relay,
            ...options,
            distributionType,
            deviceIds: ['DEVICE1', 'DEVICE2'],
          }),
        ).resolves.toEqual(profile);
        expect(relay.request.mock.calls.at(-1)[1]).toMatchObject({
          path: `/account/${platform}/profile/regenProvisioningProfile.action`,
          payload: { distributionType, deviceIds: ['DEVICE1', 'DEVICE2'] },
        });
      },
    );

    test.each(['store', 'inhouse', 'direct'] as const)(
      'allows %s without devices',
      async (distributionType) => {
        const relay = relayReturning({ provisioningProfile: profile });
        await expect(
          resources.regenerateAppleProfile({ relay, ...options, distributionType }),
        ).resolves.toEqual(profile);
      },
    );
  });

  test('rejects regeneration without a certificate before making any requests', async () => {
    const relay = relayReturning();
    await expect(
      resources.regenerateAppleProfile({
        relay,
        ...base,
        profileId: 'PROFILE',
        appIdId: 'APP',
        name: 'App',
        distributionType: 'store',
        certificateIds: [],
      }),
    ).rejects.toThrow('certificate ID');
    expect(relay.request).not.toHaveBeenCalled();
  });

  test.each([
    [
      'listAppleCloudContainers',
      '/account/cloudContainer/listCloudContainers.action',
      { cloudContainerList: [cloud] },
      [cloud],
    ],
    [
      'listAppleMerchantIDs',
      '/account/mac/identifiers/listOMCs.action',
      { identifierList: [merchant] },
      [merchant],
    ],
    [
      'listApplePassTypeIDs',
      '/account/ios/identifiers/listPassTypeIds.action',
      { passTypeIdList: [pass] },
      [pass],
    ],
    [
      'listAppleWebsitePushIDs',
      '/account/mac/identifiers/listWebsitePushIds.action',
      { websitePushIdList: [website] },
      [website],
    ],
    ['listAppleDeveloperKeys', '/account/auth/key/list', { keys: [key] }, [key]],
  ] as const)('%s reads the corresponding portal envelope', async (name, path, body, expected) => {
    const relay = relayReturning(body);
    await expect(resources[name]({ relay, ...base, platform: 'mac' })).resolves.toEqual(expected);
    expect(relay.request.mock.calls[0][1].path).toBe(path);
  });

  test.each([
    [
      'createAppleCloudContainer',
      '/account/cloudContainer/addCloudContainer.action',
      { cloudContainer: cloud },
      cloud,
    ],
    ['createAppleMerchantID', '/account/mac/identifiers/addOMC.action', { omcId: merchant }, merchant],
    ['createApplePassTypeID', '/account/ios/identifiers/addPassTypeId.action', { passTypeId: pass }, pass],
    [
      'createAppleWebsitePushID',
      '/account/mac/identifiers/addWebsitePushId.action',
      { websitePushId: website },
      website,
    ],
  ] as const)('%s uses the supplied name and identifier', async (name, path, body, expected) => {
    const relay = relayReturning(body);
    await expect(
      resources[name]({ relay, ...base, platform: 'mac', identifier: expected.identifier, name: 'Name' }),
    ).resolves.toEqual(expected);
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path,
      payload: { teamId: 'TEAM', name: 'Name', identifier: expected.identifier },
    });
  });

  test.each([
    [
      'deleteAppleAppGroup',
      '/account/ios/identifiers/deleteApplicationGroup.action',
      { applicationGroup: 'GROUP' },
    ],
    ['deleteAppleMerchantID', '/account/mac/identifiers/deleteOMC.action', { omcId: 'MERCHANT' }],
    ['deleteApplePassTypeID', '/account/ios/identifiers/deletePassTypeId.action', { passTypeId: 'PASS' }],
    [
      'deleteAppleWebsitePushID',
      '/account/mac/identifiers/deleteWebsitePushId.action',
      { websitePushId: 'WEB' },
    ],
    [
      'assignAppleCloudContainers',
      '/account/ios/identifiers/assignCloudContainerToAppId.action',
      { appIdId: 'APP', cloudContainers: ['CLOUD1', 'CLOUD2'] },
    ],
    [
      'assignAppleMerchantIDs',
      '/account/mac/identifiers/assignOMCToAppId.action',
      { appIdId: 'APP', omcIds: ['MERCHANT1', 'MERCHANT2'] },
    ],
    ['verifyAppleMerchantDomain', '/account/mac/identifiers/verifyDomain', { domainId: 'DOMAIN' }],
    [
      'deleteAppleMerchantDomain',
      '/account/mac/identifiers/removeDomain',
      { merchantId: 'MERCHANT', domainId: 'DOMAIN' },
    ],
    ['revokeAppleDeveloperKey', '/account/auth/key/revoke', { keyId: 'KEY' }],
  ] as const)('%s forwards the exact identity fields', async (name, path, payload) => {
    const relay = relayReturning();
    // Heterogeneous operations intentionally exercise distinct wire fields.
    const call = resources[name] as (options: object) => Promise<unknown>;
    await call({ relay, ...base, platform: 'mac', ...payload });
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path,
      payload: { teamId: 'TEAM', ...payload },
    });
    expect(relay.request.mock.calls[0][1].payload.pageSize).toBe(1);
  });

  test('reads app details, renames, and reads profile details without dropping portal fields', async () => {
    const relay = relayReturning({ appId: app, provisioningProfile: profile });
    await expect(
      resources.getAppleBundleIDDetails({ relay, ...base, platform: 'mac', appIdId: 'APP' }),
    ).resolves.toEqual(app);
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path: '/account/mac/identifiers/getAppIdDetail.action',
      payload: { teamId: 'TEAM', appIdId: 'APP' },
    });
    await expect(
      resources.renameAppleBundleID({ relay, ...base, platform: 'mac', appIdId: 'APP', name: 'Renamed' }),
    ).resolves.toEqual(app);
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path: '/account/mac/identifiers/updateAppIdName.action',
      payload: { teamId: 'TEAM', appIdId: 'APP', name: 'Renamed' },
    });
    await expect(
      resources.getAppleProfileDetails({ relay, ...base, platform: 'mac', profileId: 'PROFILE' }),
    ).resolves.toEqual(profile);
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path: '/account/mac/profile/getProvisioningProfile.action',
      payload: { teamId: 'TEAM', provisioningProfileId: 'PROFILE' },
    });
  });

  test('registers and reads merchant domains with their displayId', async () => {
    const relay = relayReturning({ domainList: [domain] });
    await expect(
      resources.registerAppleMerchantDomain({
        relay,
        ...base,
        platform: 'mac',
        merchantId: 'MERCHANT',
        domainName: 'example.com',
      }),
    ).resolves.toEqual(domain);
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path: '/account/mac/identifiers/registerDomain',
      payload: { teamId: 'TEAM', merchantId: 'MERCHANT', domainName: 'example.com' },
    });
    await expect(
      resources.listAppleMerchantDomains({ relay, ...base, platform: 'mac', merchantId: 'MERCHANT' }),
    ).resolves.toEqual([domain]);
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path: '/account/mac/identifiers/listDomainsForMerchant',
      payload: { teamId: 'TEAM', merchantId: 'MERCHANT' },
    });
  });

  test('reads a Developer Portal key from the single-element keys array', async () => {
    const relay = relayReturning({ keys: [key] });
    await expect(resources.getAppleDeveloperKey({ relay, ...base, keyId: 'KEY' })).resolves.toEqual(key);
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path: '/account/auth/key/get',
      payload: { teamId: 'TEAM', keyId: 'KEY' },
    });
  });

  test('downloads keep raw bytes and put identifiers in GET parameters', async () => {
    const relay = relayReturning();
    relay.request.mockResolvedValue({ status: 200, rawBodyBase64: 'AAECAw==' });
    await expect(
      resources.downloadAppleDeveloperKey({ relay, ...base, keyId: 'KEY' }),
    ).resolves.toMatchObject({ rawBodyBase64: 'AAECAw==' });
    expect(relay.request.mock.calls[0][1]).toEqual({
      method: 'GET',
      path: '/account/auth/key/download',
      payload: { teamId: 'TEAM', keyId: 'KEY' },
    });
    await resources.downloadAppleMerchantDomainVerification({
      relay,
      ...base,
      platform: 'mac',
      domainId: 'DOMAIN',
    });
    expect(relay.request.mock.calls[1][1]).toEqual({
      method: 'GET',
      path: '/account/mac/identifiers/downloadDomainVerificationFile',
      payload: { teamId: 'TEAM', domainId: 'DOMAIN' },
    });
  });

  test('rejects HTTP failures, portal errors, and missing records', async () => {
    const relay = relayReturning();
    await expect(resources.listAppleAppGroups({ relay, ...base })).rejects.toThrow('applicationGroupList');
    await expect(resources.getAppleDeveloperKey({ relay, ...base, keyId: 'KEY' })).rejects.toThrow(
      'no record',
    );
    relay.request.mockResolvedValue({ status: 403, statusText: 'Forbidden' });
    await expect(resources.listAppleAppGroups({ relay, ...base })).rejects.toThrow('HTTP 403');
    await expect(resources.downloadAppleDeveloperKey({ relay, ...base, keyId: 'KEY' })).rejects.toThrow(
      'HTTP 403',
    );
    relay.request.mockResolvedValue({ status: 200, body: { resultCode: 35, userString: 'No permission' } });
    await expect(
      resources.assignAppleAppGroups({ relay, ...base, appIdId: 'APP', applicationGroups: ['GROUP'] }),
    ).rejects.toThrow('No permission');
    await expect(resources.downloadAppleDeveloperKey({ relay, ...base, keyId: 'KEY' })).rejects.toThrow(
      'No permission',
    );
  });
});

describe('macOS namespaces on existing helpers', () => {
  test('registers and enables a Mac without changing its UDID', async () => {
    const relay = relayReturning({ devices: [{ deviceId: 'DEVICE' }] });
    await portal.registerAppleDevice({
      relay,
      ...base,
      platform: 'mac',
      deviceUDID: '00006000-0011223344556677',
    });
    expect(relay.request.mock.calls[0][1]).toEqual({
      method: 'POST',
      path: '/account/mac/device/addDevices.action',
      payload: {
        teamId: 'TEAM',
        deviceClasses: 'mac',
        deviceNumbers: '00006000-0011223344556677',
        deviceNames: 'Limrun Mac',
        register: 'single',
      },
    });
    await resources.enableAppleDevice({
      relay,
      ...base,
      platform: 'mac',
      deviceId: 'DEVICE',
      deviceUDID: '00006000-0011223344556677',
    });
    expect(relay.request.mock.calls.at(-1)[1]).toEqual({
      method: 'POST',
      path: '/account/mac/device/enableDevice.action',
      payload: { teamId: 'TEAM', displayId: 'DEVICE', deviceNumber: '00006000-0011223344556677' },
    });
    await portal.listAppleDevices({ relay, ...base, platform: 'mac', includeDisabled: true });
    expect(relay.request.mock.calls.at(-1)[1]).toMatchObject({
      path: '/account/mac/device/listDevices.action',
      payload: { includeRemovedDevices: true },
    });
  });

  test('routes bundle, certificate, and profile helpers to mac without the iOS subPlatform', async () => {
    const relay = relayReturning({
      appIds: [app],
      appId: app,
      provisioningProfile: profile,
      provisioningProfiles: [profile],
      certRequests: [],
      certRequest: {},
    });
    const options = { relay, ...base, platform: 'mac' as const };
    await portal.listAppleBundleIDs(options);
    await portal.createAppleBundleID({ ...options, bundleId: app.identifier });
    await portal.deleteAppleBundleID({ ...options, appIdId: 'APP' });
    await portal.listAppleCertificates(options);
    await portal.createAppleCertificate({ ...options, csrPEM: 'CSR' });
    await portal.downloadAppleCertificate({ ...options, certificateId: 'CERT' });
    await portal.deleteAppleCertificate({ ...options, certificateId: 'CERT' });
    await portal.listAppleProfiles(options);
    await portal.createAppleProfile({
      ...options,
      bundleId: app.identifier,
      appIdId: 'APP',
      certificateIds: ['CERT'],
      deviceIds: ['DEVICE'],
    });
    expect(relay.request.mock.calls.at(-1)[1].payload).not.toHaveProperty('subPlatform');
    await portal.downloadAppleProfile({ ...options, profileId: 'PROFILE' });
    await portal.deleteAppleProfile({ ...options, profileId: 'PROFILE' });
    await portal.deleteAppleDevice({ ...options, deviceId: 'DEVICE' });
    for (const [, request] of relay.request.mock.calls) expect(request.path).toMatch(/^\/account\/mac\//);
  });
});
