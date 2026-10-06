import type { AppleTeamScopedOptions } from './portal';
import type { AppleDeveloperKey } from './portal-resources';
import { paged, portalRequest, type PortalEnvelope } from './internal/portal';

export type AppleTeamMemberRole = 'admin' | 'member';
export type AppleTeamMember = {
  teamMemberId: string;
  personId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  developerStatus?: string;
  dateJoined?: string | number;
  role: AppleTeamMemberRole | 'agent';
};
export type AppleTeamInvite = {
  inviteId: string;
  inviterName?: string;
  recipientEmail?: string;
  recipientRole?: string;
  dateCreated?: string | number;
  dateExpires?: string | number;
};

type PortalMember = Omit<AppleTeamMember, 'role'>;
type TeamResponse = PortalEnvelope & {
  members?: PortalMember | PortalMember[];
  admins?: PortalMember | PortalMember[];
  agent?: PortalMember | PortalMember[];
  invites?: AppleTeamInvite | AppleTeamInvite[];
};

/** Apple's agreement payload varies by team and is returned without renaming fields. */
export type ApplePendingAgreements = PortalEnvelope & Record<string, unknown>;
export type ListApplePendingAgreementsOptions = AppleTeamScopedOptions & { language?: string };
export async function listApplePendingAgreements({
  relay,
  teamId = '',
  language = 'en',
}: ListApplePendingAgreementsOptions): Promise<ApplePendingAgreements> {
  return portalRequest<ApplePendingAgreements>(
    relay,
    {
      method: 'POST',
      path: '/account/listPendingAgreements',
      payload: { teamId, languageIsoCode: language },
    },
    'Apple pending agreements',
  );
}

function records<T>(value: T | T[] | undefined): T[] {
  return (
    value === undefined || value === null ? []
    : Array.isArray(value) ? value
    : [value]
  );
}

/** Flattens Apple's member, admin, and account-holder groups while preserving their roles. */
export async function listAppleTeamMembers({
  relay,
  teamId = '',
}: AppleTeamScopedOptions): Promise<AppleTeamMember[]> {
  const body = await portalRequest<TeamResponse>(
    relay,
    {
      method: 'POST',
      path: '/account/getTeamMembers',
      payload: { teamId },
    },
    'Apple team members',
  );
  if (body.members === undefined && body.admins === undefined && body.agent === undefined) {
    throw new Error('Apple team members returned no member groups.');
  }
  return [
    ...records(body.members).map((member) => ({ ...member, role: 'member' as const })),
    ...records(body.admins).map((member) => ({ ...member, role: 'admin' as const })),
    ...records(body.agent).map((member) => ({ ...member, role: 'agent' as const })),
  ];
}

export async function listAppleTeamInvites({
  relay,
  teamId = '',
}: AppleTeamScopedOptions): Promise<AppleTeamInvite[]> {
  const body = await portalRequest<TeamResponse>(
    relay,
    {
      method: 'POST',
      path: '/account/getInvites',
      payload: { teamId },
    },
    'Apple team invitations',
  );
  if (body.invites === undefined) throw new Error('Apple team invitations returned no invites.');
  return records(body.invites);
}

export type SetAppleTeamMemberRoleOptions = AppleTeamScopedOptions & {
  teamMemberId: string;
  role: AppleTeamMemberRole;
};
export async function setAppleTeamMemberRole(options: SetAppleTeamMemberRoleOptions): Promise<void> {
  const { relay, teamId = '', teamMemberId, role } = options;
  await listAppleTeamMembers(options);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/setTeamMemberRoles',
      payload: { teamId, role, teamMemberIds: [teamMemberId] },
    },
    'Apple team member role update',
  );
}

export type RemoveAppleTeamMemberOptions = AppleTeamScopedOptions & { teamMemberId: string };
export async function removeAppleTeamMember(options: RemoveAppleTeamMemberOptions): Promise<void> {
  const { relay, teamId = '', teamMemberId } = options;
  await listAppleTeamMembers(options);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/removeTeamMembers',
      payload: { teamId, teamMemberIds: [teamMemberId] },
    },
    'Apple team member removal',
  );
}

export type InviteAppleTeamMemberOptions = AppleTeamScopedOptions & {
  email: string;
  role: AppleTeamMemberRole;
};
export async function inviteAppleTeamMember(options: InviteAppleTeamMemberOptions): Promise<void> {
  const { relay, teamId = '', email, role } = options;
  await listAppleTeamMembers(options);
  await portalRequest(
    relay,
    {
      method: 'POST',
      path: '/account/sendInvites',
      payload: { teamId, invites: [{ recipientEmail: email, recipientRole: role }] },
    },
    'Apple team invitation',
  );
}

export type CreateAppleDeveloperKeyOptions = AppleTeamScopedOptions & {
  name: string;
  /** Enables team-scoped APNs access in both development and production, matching Fastlane's default. */
  apns?: boolean;
  deviceCheck?: boolean;
  /** Apple's opaque Music ID, not its music.* identifier. */
  musicId?: string;
};

/** Creates a service key; download its private bytes separately with downloadAppleDeveloperKey. */
export async function createAppleDeveloperKey(
  options: CreateAppleDeveloperKeyOptions,
): Promise<AppleDeveloperKey> {
  const { relay, teamId = '', name, apns = false, deviceCheck = false, musicId } = options;
  if (!name.trim()) throw new Error('A name is required to create an Apple Developer key.');
  if (!apns && !deviceCheck && !musicId?.trim()) {
    throw new Error('Select APNs, DeviceCheck, or a Music ID for the Apple Developer key.');
  }
  // The key list refreshes the CSRF headers used for key creation.
  await portalRequest(
    relay,
    paged('/account/auth/key/list', teamId, { pageSize: 1 }),
    'Apple Developer key session',
  );
  const serviceConfigurationsRequests = [
    ...(apns ?
      [{ serviceId: 'U27F4V844T', isNew: true, identifiers: {}, environment: 'all', scope: 'team' }]
    : []),
    ...(deviceCheck ? [{ serviceId: 'DQ8HTZ7739', isNew: true, identifiers: {} }] : []),
    ...(musicId ? [{ serviceId: '6A7HVUVQ3M', isNew: true, identifiers: { music: [musicId] } }] : []),
  ];
  const body = await portalRequest<PortalEnvelope & { keys?: AppleDeveloperKey[] }>(
    relay,
    {
      method: 'POST',
      path: '/account/auth/key/v2/create',
      payload: { teamId, name, serviceConfigurationsRequests },
    },
    'Apple Developer key creation',
  );
  const key = body.keys?.[0];
  if (!key?.keyId) throw new Error('Apple Developer key creation did not return a key ID.');
  return key;
}
