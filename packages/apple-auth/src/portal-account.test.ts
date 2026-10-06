// @vitest-environment node
import { describe, expect, test, vi } from 'vitest';
import type { AppleRelayWebSocketClient } from './relay';
import {
  createAppleDeveloperKey,
  inviteAppleTeamMember,
  listApplePendingAgreements,
  listAppleTeamInvites,
  listAppleTeamMembers,
  removeAppleTeamMember,
  setAppleTeamMemberRole,
} from './portal-account';

const member = {
  teamMemberId: 'MEMBER',
  personId: 'PERSON',
  email: 'developer@example.com',
  dateJoined: 1501106986000,
};
const team = { members: [member], admins: [], agent: { teamMemberId: 'OWNER', email: 'owner@example.com' } };
const key = { keyId: 'KEY', keyName: 'App services', canDownload: true };
const base = { teamId: 'TEAM' };
function relayReturning(body: Record<string, unknown> = {}) {
  const request = vi
    .fn()
    .mockResolvedValue({ status: 200, statusText: 'OK', body: { resultCode: 0, ...body } });
  return { request } as unknown as AppleRelayWebSocketClient & { request: typeof request };
}

describe('Developer Portal JSON calls', () => {
  test('preserves the agreement envelope and requested language', async () => {
    const body = {
      resultCode: 0,
      pendingAgreements: [{ agreementId: 'AGREEMENT', title: 'Updated terms' }],
      locale: 'tr',
    };
    const relay = relayReturning(body);
    await expect(listApplePendingAgreements({ relay, ...base, language: 'tr' })).resolves.toEqual(body);
    expect(relay.request).toHaveBeenCalledWith('provisioning', {
      method: 'POST',
      path: '/account/listPendingAgreements',
      payload: { teamId: 'TEAM', languageIsoCode: 'tr' },
    });
    await listApplePendingAgreements({ relay, ...base });
    expect(relay.request.mock.calls.at(-1)[1].payload.languageIsoCode).toBe('en');
  });

  test('flattens single objects and arrays into members with their actual roles', async () => {
    const relay = relayReturning({ ...team, members: member, admins: [{ teamMemberId: 'ADMIN' }] });
    await expect(listAppleTeamMembers({ relay, ...base })).resolves.toEqual([
      { ...member, role: 'member' },
      { teamMemberId: 'ADMIN', role: 'admin' },
      { ...team.agent, role: 'agent' },
    ]);
    expect(relay.request.mock.calls[0]).toEqual([
      'provisioning',
      { method: 'POST', path: '/account/getTeamMembers', payload: { teamId: 'TEAM' } },
    ]);
  });

  test('accepts an empty team list and rejects a missing response shape', async () => {
    const relay = relayReturning({ members: [], admins: [], agent: null });
    await expect(listAppleTeamMembers({ relay, ...base })).resolves.toEqual([]);
    relay.request.mockResolvedValue({ status: 200, body: {} });
    await expect(listAppleTeamMembers({ relay, ...base })).rejects.toThrow('no member groups');
  });

  test('reads invitations as a single record or array without changing dates or roles', async () => {
    const invite = {
      inviteId: 'INVITE',
      recipientEmail: member.email,
      recipientRole: 'ADMIN',
      dateCreated: 1501106986000,
    };
    const relay = relayReturning({ invites: invite });
    await expect(listAppleTeamInvites({ relay, ...base })).resolves.toEqual([invite]);
    expect(relay.request.mock.calls[0]).toEqual([
      'provisioning',
      { method: 'POST', path: '/account/getInvites', payload: { teamId: 'TEAM' } },
    ]);
    relay.request.mockResolvedValue({ status: 200, body: { invites: [] } });
    await expect(listAppleTeamInvites({ relay, ...base })).resolves.toEqual([]);
  });

  test('primes membership CSRF headers before role, removal, and invitation writes', async () => {
    const relay = relayReturning(team);
    await setAppleTeamMemberRole({ relay, ...base, teamMemberId: 'MEMBER', role: 'admin' });
    await removeAppleTeamMember({ relay, ...base, teamMemberId: 'MEMBER' });
    await inviteAppleTeamMember({ relay, ...base, email: member.email, role: 'member' });
    expect(relay.request.mock.calls.map((call) => call[1])).toEqual([
      { method: 'POST', path: '/account/getTeamMembers', payload: { teamId: 'TEAM' } },
      {
        method: 'POST',
        path: '/account/setTeamMemberRoles',
        payload: { teamId: 'TEAM', role: 'admin', teamMemberIds: ['MEMBER'] },
      },
      { method: 'POST', path: '/account/getTeamMembers', payload: { teamId: 'TEAM' } },
      {
        method: 'POST',
        path: '/account/removeTeamMembers',
        payload: { teamId: 'TEAM', teamMemberIds: ['MEMBER'] },
      },
      { method: 'POST', path: '/account/getTeamMembers', payload: { teamId: 'TEAM' } },
      {
        method: 'POST',
        path: '/account/sendInvites',
        payload: { teamId: 'TEAM', invites: [{ recipientEmail: member.email, recipientRole: 'member' }] },
      },
    ]);
  });

  test('creates all three service configurations with nested arrays and booleans', async () => {
    const relay = relayReturning({ keys: [key] });
    await expect(
      createAppleDeveloperKey({
        relay,
        ...base,
        name: 'App services',
        apns: true,
        deviceCheck: true,
        musicId: 'MUSIC',
      }),
    ).resolves.toEqual(key);
    expect(relay.request.mock.calls.map((call) => call[1])).toEqual([
      {
        method: 'POST',
        path: '/account/auth/key/list',
        payload: { teamId: 'TEAM', pageNumber: 1, pageSize: 1, sort: 'name=asc' },
      },
      {
        method: 'POST',
        path: '/account/auth/key/v2/create',
        payload: {
          teamId: 'TEAM',
          name: 'App services',
          serviceConfigurationsRequests: [
            { serviceId: 'U27F4V844T', isNew: true, identifiers: {}, environment: 'all', scope: 'team' },
            { serviceId: 'DQ8HTZ7739', isNew: true, identifiers: {} },
            { serviceId: '6A7HVUVQ3M', isNew: true, identifiers: { music: ['MUSIC'] } },
          ],
        },
      },
    ]);
  });

  test.each([
    [
      { apns: true },
      { serviceId: 'U27F4V844T', isNew: true, identifiers: {}, environment: 'all', scope: 'team' },
    ],
    [{ deviceCheck: true }, { serviceId: 'DQ8HTZ7739', isNew: true, identifiers: {} }],
    [{ musicId: 'MUSIC' }, { serviceId: '6A7HVUVQ3M', isNew: true, identifiers: { music: ['MUSIC'] } }],
  ])('creates only the requested service', async (selected, expected) => {
    const relay = relayReturning({ keys: [key] });
    await createAppleDeveloperKey({ relay, ...base, name: 'Service', ...selected });
    expect(relay.request.mock.calls.at(-1)[1].payload.serviceConfigurationsRequests).toEqual([expected]);
  });

  test('rejects invalid key input before contacting Apple', async () => {
    const relay = relayReturning();
    await expect(createAppleDeveloperKey({ relay, ...base, name: ' ', apns: true })).rejects.toThrow('name');
    await expect(createAppleDeveloperKey({ relay, ...base, name: 'Service' })).rejects.toThrow('Select APNs');
    expect(relay.request).not.toHaveBeenCalled();
  });

  test('rejects key creation responses without a key ID', async () => {
    const relay = relayReturning({ keys: [{}] });
    await expect(createAppleDeveloperKey({ relay, ...base, name: 'Service', apns: true })).rejects.toThrow(
      'key ID',
    );
  });

  test('a rejected CSRF refresh prevents the write', async () => {
    const relay = relayReturning({ resultCode: 35, userString: 'No permission' });
    await expect(removeAppleTeamMember({ relay, ...base, teamMemberId: 'MEMBER' })).rejects.toThrow(
      'No permission',
    );
    expect(relay.request).toHaveBeenCalledTimes(1);
  });

  test('surfaces errors from JSON writes and does not retry key creation', async () => {
    const relay = relayReturning({ resultCode: 35, userString: 'No permission' });
    relay.request.mockResolvedValueOnce({ status: 200, body: { resultCode: 0, keys: [] } });
    await expect(createAppleDeveloperKey({ relay, ...base, name: 'Service', apns: true })).rejects.toThrow(
      'No permission',
    );
    expect(relay.request).toHaveBeenCalledTimes(2);
    relay.request.mockResolvedValue({ status: 403, statusText: 'Forbidden' });
    await expect(listAppleTeamInvites({ relay, ...base })).rejects.toThrow('HTTP 403');
  });
});
