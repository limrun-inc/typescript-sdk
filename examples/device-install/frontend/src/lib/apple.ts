import type { AppleDeveloperPortalAppID, AppleDeveloperPortalTeam } from '@limrun/apple-auth';

export function appleTeamSelectionId(team?: AppleDeveloperPortalTeam) {
  const value = team?.teamId ?? team?.providerId ?? team?.publicProviderId;
  return value === undefined || value === '' ? undefined : String(value);
}

export function appIdIdentifier(appId?: AppleDeveloperPortalAppID) {
  return appId?.appIdId ?? appId?.appId ?? appId?.identifier ?? appId?.bundleId;
}

export function appIdBundleId(appId?: AppleDeveloperPortalAppID) {
  return appId?.identifier ?? appId?.bundleId;
}

export function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
