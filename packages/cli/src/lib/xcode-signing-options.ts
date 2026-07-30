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
