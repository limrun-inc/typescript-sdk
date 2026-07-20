// Small, pure helpers for working with the Apple Developer Portal data returned
// by `@limrun/ui/apple`. The portal's JSON is loosely typed and uses
// different field names across account types, so these helpers normalise it.
import type { AppleDeveloperPortalAppID, AppleDeveloperPortalTeam } from '@limrun/ui/apple';

/**
 * Apple exposes a team's portal id under one of three fields depending on the
 * account type. Resolving them in priority order means teams whose id lives in
 * `providerId`/`publicProviderId` still drive the flow instead of leaving the
 * developer team id undefined after sign-in.
 */
export function appleTeamSelectionId(team?: AppleDeveloperPortalTeam) {
  const value = team?.teamId ?? team?.providerId ?? team?.publicProviderId;
  return value === undefined || value === '' ? undefined : String(value);
}

/** The numeric provider ID App Store Connect uses to scope a web session. */
export function appleTeamProviderId(team?: AppleDeveloperPortalTeam) {
  const value = team?.providerId;
  return value === undefined || value === '' ? undefined : String(value);
}

export function appIdIdentifier(appId?: AppleDeveloperPortalAppID) {
  return appId?.appIdId ?? appId?.appId ?? appId?.identifier ?? appId?.bundleId;
}

export function appIdBundleId(appId?: AppleDeveloperPortalAppID) {
  return appId?.identifier ?? appId?.bundleId;
}

/** Read a string-ish value from a loosely typed portal record. */
export function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
