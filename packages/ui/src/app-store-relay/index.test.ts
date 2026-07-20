// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  assertAppleDeveloperPortalResponseOK,
  deleteAppleProfile,
  downloadAppStoreConnectApiKeyPrivateKey,
  listAppleTeams,
} from './index';

describe('Registry relay primitives', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('sends explicit CRUD requests through the provisioning proxy', async () => {
    const relay = { request: vi.fn().mockResolvedValue({ status: 200, body: { resultCode: 0 } }) };

    await deleteAppleProfile({
      relay,
      teamId: 'TEAM',
      profileId: 'PROFILE',
    });

    expect(relay.request).toHaveBeenCalledOnce();
    expect(relay.request.mock.calls[0]).toMatchObject([
      'provisioning',
      {
        method: 'POST',
        path: '/account/ios/profile/deleteProvisioningProfile.action',
        payload: {
          teamId: 'TEAM',
          provisioningProfileId: 'PROFILE',
        },
      },
    ]);
  });

  test('maps team list responses to teams', async () => {
    const relay = {
      request: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          resultCode: 0,
          teams: [{ name: 'Team One', teamId: 'TEAM1' }],
        },
      }),
    };

    await expect(
      listAppleTeams({
        relay,
      }),
    ).resolves.toEqual([{ name: 'Team One', teamId: 'TEAM1' }]);
  });

  test('surfaces Apple portal errors', () => {
    expect(() =>
      assertAppleDeveloperPortalResponseOK(
        { resultCode: 35, userString: 'No permission' },
        'Apple device list',
      ),
    ).toThrow('Apple device list failed: No permission');
  });
});

describe('App Store Connect API key download', () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----\n';

  function relayServing(privateKey: string) {
    return {
      request: vi.fn().mockResolvedValue({
        status: 200,
        body: { data: { type: 'apiKeys', id: 'KEY1', attributes: { privateKey } } },
      }),
    };
  }

  // Apple serves the privateKey attribute as base64 of the .p8 PEM text.
  // Storing it re-encoded once more used to double-encode the key, which
  // limbuild rejected with "not a valid EC private key".
  test('decodes the base64-encoded PEM Apple actually serves', async () => {
    const relay = relayServing(btoa(PEM));
    await expect(downloadAppStoreConnectApiKeyPrivateKey({ relay, keyId: 'KEY1' })).resolves.toMatchObject(
      { privateKeyPem: PEM },
    );
  });

  test('passes through a key already in PEM form', async () => {
    const relay = relayServing(PEM);
    await expect(downloadAppStoreConnectApiKeyPrivateKey({ relay, keyId: 'KEY1' })).resolves.toMatchObject(
      { privateKeyPem: PEM },
    );
  });

  test('rejects unrecognizable private key payloads', async () => {
    const relay = relayServing(btoa('not a pem at all'));
    await expect(downloadAppStoreConnectApiKeyPrivateKey({ relay, keyId: 'KEY1' })).rejects.toThrow(
      'unrecognized format',
    );
  });
});
