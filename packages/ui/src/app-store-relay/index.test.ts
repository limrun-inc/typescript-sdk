// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest';
import { assertAppleDeveloperPortalResponseOK, deleteAppleProfile, listAppleTeams } from './index';

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
