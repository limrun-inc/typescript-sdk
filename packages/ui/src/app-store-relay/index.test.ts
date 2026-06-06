// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  assertAppleDeveloperPortalResponseOK,
  deleteAppleProfile,
  listAppleTeams,
} from './index';

describe('App Store relay primitives', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('sends explicit CRUD requests through the provisioning proxy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 200, body: { resultCode: 0 } }), {
        status: 200,
      }),
    );

    await deleteAppleProfile({
      apiUrl: 'https://limbuild.example',
      token: 'token',
      appleSessionId: 'apple-session',
      teamId: 'TEAM',
      profileId: 'PROFILE',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://limbuild.example/apple/provisioning?token=token');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      appleSessionId: 'apple-session',
      method: 'POST',
      path: '/account/ios/profile/deleteProvisioningProfile.action',
      payload: {
        teamId: 'TEAM',
        provisioningProfileId: 'PROFILE',
      },
    });
  });

  test('maps team list responses to teams', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          body: {
            resultCode: 0,
            teams: [{ name: 'Team One', teamId: 'TEAM1' }],
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      listAppleTeams({
        apiUrl: 'https://limbuild.example',
        appleSessionId: 'apple-session',
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
