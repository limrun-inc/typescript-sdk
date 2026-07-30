import type { XcodeSigningConfig } from '@limrun/api';

export interface XcodeSigningFlagValues {
  'certificate-p12'?: string;
  'certificate-password'?: string;
  'provisioning-profile'?: string[];
}

export function hasSigningFlags(flags: XcodeSigningFlagValues): boolean {
  return (
    flags['certificate-p12'] !== undefined ||
    flags['certificate-password'] !== undefined ||
    flags['provisioning-profile'] !== undefined
  );
}

/**
 * Returns the problem with an incomplete signing flag group, or undefined
 * when the group is absent or complete. Pure and oclif-free so the command
 * can reject a doomed combination before resolving (and possibly
 * auto-creating) a billed instance.
 */
export function signingFlagsProblem(flags: XcodeSigningFlagValues): string | undefined {
  if (!hasSigningFlags(flags)) {
    return undefined;
  }
  if (
    flags['certificate-p12'] === undefined ||
    flags['certificate-password'] === undefined ||
    flags['provisioning-profile'] === undefined
  ) {
    return 'Signed device builds require --certificate-p12, --certificate-password, and --provisioning-profile.';
  }
  return undefined;
}

/**
 * Maps the read signing material to the exec request's signing config.
 * Exactly one profile uses the single-profile field so older limbuild
 * servers keep working. Multiple profiles use ONLY the array field: an old
 * server that does not understand it then fails the build loudly instead of
 * silently signing every bundle with one profile, which is the exact broken
 * archive multi-profile signing exists to prevent.
 */
export function signingConfigFromMaterial(
  certificateP12Base64: string,
  certificatePassword: string,
  provisioningProfilesBase64: string[],
): XcodeSigningConfig {
  return {
    certificateP12Base64,
    certificatePassword,
    ...(provisioningProfilesBase64.length === 1 ?
      { provisioningProfileBase64: provisioningProfilesBase64[0] }
    : { provisioningProfilesBase64 }),
  };
}
