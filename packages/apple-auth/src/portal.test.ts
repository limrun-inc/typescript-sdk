// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import type { AppleRelayWebSocketClient } from './relay';
import {
  createAppleCertificate,
  createAppleProfile,
  deleteAppleProfile,
  downloadAppleCertificate,
  listAppleCertificates,
  listAppleDevices,
  listAppleTeams,
} from './portal';

function relayReturning(body: Record<string, unknown>) {
  return {
    request: vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', body: { resultCode: 0, ...body } }),
  } as unknown as AppleRelayWebSocketClient & { request: ReturnType<typeof vi.fn> };
}

describe('Developer Portal certificate requests', () => {
  test('lists development certificates with Apple Development type codes', async () => {
    const relay = relayReturning({ certRequests: [] });
    await listAppleCertificates({ relay, teamId: 'TEAM' });
    expect(relay.request.mock.calls[0]).toMatchObject([
      'provisioning',
      {
        path: '/account/ios/certificate/listCertRequests.action',
        payload: { teamId: 'TEAM', types: '83Q87W3TGH,5QPB9NHCEI' },
      },
    ]);
  });

  test('uses distribution type codes for distribution certificates', async () => {
    const relay = relayReturning({ certRequests: [] });
    await listAppleCertificates({ relay, teamId: 'TEAM', certificateKind: 'distribution' });
    expect(relay.request.mock.calls[0][1]).toMatchObject({
      payload: { types: 'WXV89964HE,R58UK2EWSO' },
    });

    await createAppleCertificate({ relay, teamId: 'TEAM', certificateKind: 'distribution', csrPEM: 'csr' });
    expect(relay.request.mock.calls[1][1]).toMatchObject({
      path: '/account/ios/certificate/submitCertificateRequest.action',
      payload: { teamId: 'TEAM', type: 'WXV89964HE', csrContent: 'csr' },
    });

    await downloadAppleCertificate({
      relay,
      teamId: 'TEAM',
      certificateKind: 'distribution',
      certificateId: 'CERT',
    });
    expect(relay.request.mock.calls[2][1]).toMatchObject({
      method: 'GET',
      path: '/account/ios/certificate/downloadCertificateContent.action',
      payload: { teamId: 'TEAM', certificateId: 'CERT', type: 'WXV89964HE' },
    });
  });
});

describe('Developer Portal profile requests', () => {
  const base = {
    teamId: 'TEAM',
    bundleId: 'com.example.app',
    appIdId: 'APP',
    certificateIds: ['CERT'],
  };

  test('builds development, Ad Hoc and App Store profile payloads', async () => {
    const relay = relayReturning({ provisioningProfile: {} });

    await createAppleProfile({ relay, ...base, deviceIds: ['DEVICE'] });
    expect(relay.request.mock.calls[0][1]).toMatchObject({
      path: '/account/ios/profile/createProvisioningProfile.action',
      payload: {
        provisioningProfileName: 'Limrun com.example.app',
        distributionType: 'limited',
        deviceIds: ['DEVICE'],
        subPlatform: 'ios',
      },
    });

    await createAppleProfile({ relay, ...base, profileKind: 'adhoc', deviceIds: ['DEVICE'] });
    expect(relay.request.mock.calls[1][1]).toMatchObject({
      payload: {
        provisioningProfileName: 'Limrun Ad Hoc com.example.app',
        distributionType: 'adhoc',
      },
    });

    await createAppleProfile({ relay, ...base, profileKind: 'appstore', name: 'Store Profile' });
    const appStorePayload = relay.request.mock.calls[2][1].payload as Record<string, unknown>;
    expect(appStorePayload).toMatchObject({
      provisioningProfileName: 'Store Profile',
      distributionType: 'store',
    });
    expect(appStorePayload).not.toHaveProperty('deviceIds');
  });

  test('requires an explicit name for App Store profiles', async () => {
    const relay = relayReturning({});
    await expect(createAppleProfile({ relay, ...base, profileKind: 'appstore' })).rejects.toThrow(
      'explicit name',
    );
  });

  test('sends explicit deletion requests', async () => {
    const relay = relayReturning({});
    await deleteAppleProfile({ relay, teamId: 'TEAM', profileId: 'PROFILE' });
    expect(relay.request.mock.calls[0]).toMatchObject([
      'provisioning',
      {
        method: 'POST',
        path: '/account/ios/profile/deleteProvisioningProfile.action',
        payload: { teamId: 'TEAM', provisioningProfileId: 'PROFILE' },
      },
    ]);
  });
});

describe('Developer Portal responses', () => {
  test('maps team list responses to a deduplicated team array', async () => {
    const relay = relayReturning({
      teams: [{ name: 'Team One', teamId: 'TEAM1' }],
      provider: { name: 'Team One', teamId: 'TEAM1' },
    });
    await expect(listAppleTeams({ relay })).resolves.toEqual([{ name: 'Team One', teamId: 'TEAM1' }]);
  });

  test('surfaces Apple portal errors', async () => {
    const relay = {
      request: vi.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        body: { resultCode: 35, userString: 'No permission' },
      }),
    } as unknown as AppleRelayWebSocketClient;
    await expect(listAppleDevices({ relay, teamId: 'TEAM' })).rejects.toThrow(
      'Apple device list failed: No permission',
    );
  });
});
