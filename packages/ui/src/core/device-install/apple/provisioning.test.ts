// @vitest-environment node

import { describe, expect, test } from 'vitest';
import {
  createAdHocProfileRequest,
  createDevelopmentProfileRequest,
  downloadDistributionCertificateRequest,
  findAdHocProfilesRequest,
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

  test('filters Ad Hoc profile list requests by Ad Hoc distribution type', () => {
    expect(findAdHocProfilesRequest({ bundleID: 'com.example.app', teamID: 'TEAM' }).payload).toMatchObject({
      teamId: 'TEAM',
      search: 'com.example.app',
      distributionType: 'adhoc',
    });
  });
});
