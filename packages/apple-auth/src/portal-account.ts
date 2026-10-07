import type { AppleTeamScopedOptions } from './portal';
import type { AppleDeveloperKey } from './portal-resources';
import { paged, portalRequest, type PortalEnvelope } from './internal/portal';

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
