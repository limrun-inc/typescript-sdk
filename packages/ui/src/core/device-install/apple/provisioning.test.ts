// @vitest-environment node

import { describe, expect, test } from 'vitest';
import {
  createAdHocProfileRequest,
  createAppStoreProfileRequest,
  createDevelopmentProfileRequest,
  downloadDistributionCertificateRequest,
  findAdHocProfilesRequest,
  findAppStoreProfilesRequest,
  findDevelopmentCertificatesRequest,
  findDistributionCertificatesRequest,
  submitDistributionCSRRequest,
} from './provisioning';

describe('Apple provisioning request helpers', () => {
  test('keeps development certificate requests on Apple Development types', () => {
    expect(findDevelopmentCertificatesRequest('TEAM').payload).toMatchObject({
      teamId: 'TEAM',
      types: '83Q87W3TGH,5QPB9NHCEI',
    });
  });

  test('uses distribution certificate requests for Ad Hoc signing', () => {
    expect(findDistributionCertificatesRequest('TEAM').payload).toMatchObject({
      teamId: 'TEAM',
      types: 'WXV89964HE,R58UK2EWSO',
    });
    expect(submitDistributionCSRRequest({ csrPEM: 'csr', teamID: 'TEAM' }).payload).toMatchObject({
      teamId: 'TEAM',
      type: 'WXV89964HE',
      csrContent: 'csr',
    });
    expect(downloadDistributionCertificateRequest('CERT', 'TEAM').payload).toMatchObject({
      teamId: 'TEAM',
      certificateId: 'CERT',
      type: 'WXV89964HE',
    });
  });

  test('builds separate development and Ad Hoc profile payloads', () => {
    expect(
      createDevelopmentProfileRequest({
        bundleID: 'com.example.app',
        teamID: 'TEAM',
        appIDID: 'APP',
        certificateID: 'CERT',
        deviceIDs: ['DEVICE'],
      }).payload,
    ).toMatchObject({
      teamId: 'TEAM',
      provisioningProfileName: 'Limrun com.example.app',
      certificateIds: ['CERT'],
      appIdId: 'APP',
      deviceIds: ['DEVICE'],
      distributionType: 'limited',
      subPlatform: 'ios',
    });

    expect(
      createAdHocProfileRequest({
        bundleID: 'com.example.app',
        teamID: 'TEAM',
        appIDID: 'APP',
        certificateID: 'CERT',
        deviceIDs: ['DEVICE'],
      }).payload,
    ).toMatchObject({
      teamId: 'TEAM',
      provisioningProfileName: 'Limrun Ad Hoc com.example.app',
      certificateIds: ['CERT'],
      appIdId: 'APP',
      deviceIds: ['DEVICE'],
      distributionType: 'adhoc',
      subPlatform: 'ios',
    });
  });

  test('filters Ad Hoc profile list requests by Ad Hoc distribution type without a search parameter', () => {
    const payload = findAdHocProfilesRequest('TEAM').payload;
    expect(payload).toMatchObject({
      teamId: 'TEAM',
      distributionType: 'adhoc',
    });
    // Apple rejects bundle-id-shaped values for `search`; filtering is client-side.
    expect(payload).not.toHaveProperty('search');
  });

  test('builds App Store profile payloads without devices and with the caller-provided name', () => {
    expect(
      createAppStoreProfileRequest({
        teamID: 'TEAM',
        appIDID: 'APP',
        certificateID: 'CERT',
        name: 'Acme App Store com.example.app',
      }).payload,
    ).toEqual({
      teamId: 'TEAM',
      provisioningProfileName: 'Acme App Store com.example.app',
      certificateIds: ['CERT'],
      appIdId: 'APP',
      distributionType: 'store',
      subPlatform: 'ios',
    });
  });

  test('filters App Store profile list requests by store distribution type without a search parameter', () => {
    const payload = findAppStoreProfilesRequest('TEAM').payload;
    expect(payload).toMatchObject({
      teamId: 'TEAM',
      distributionType: 'store',
    });
    // Apple rejects bundle-id-shaped values for `search`; filtering is client-side.
    expect(payload).not.toHaveProperty('search');
  });
});
