export interface XcodeSigningFlagValues {
  'certificate-p12'?: string;
  'certificate-password'?: string;
  'provisioning-profile'?: string[];
}

export interface XcodeCloudSigningFlagValues extends XcodeSigningFlagValues {
  'signing-method'?: string;
  'team-id'?: string;
  'asc-key-id'?: string;
  'asc-issuer-id'?: string;
  'asc-key'?: string;
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

export function hasCloudSigningFlags(flags: XcodeCloudSigningFlagValues): boolean {
  return flags['signing-method'] !== undefined || flags['team-id'] !== undefined;
}

export function cloudSigningFlagsProblem(flags: XcodeCloudSigningFlagValues): string | undefined {
  if (!hasCloudSigningFlags(flags)) {
    return undefined;
  }
  if (flags['signing-method'] === undefined) {
    return '--team-id requires --signing-method.';
  }
  if (hasSigningFlags(flags)) {
    return 'Cloud signing flags cannot be combined with --certificate-p12, --certificate-password, or --provisioning-profile.';
  }
  const missing: string[] = [];
  if (flags['team-id'] === undefined) missing.push('--team-id');
  if (flags['asc-key-id'] === undefined) missing.push('--asc-key-id');
  if (flags['asc-issuer-id'] === undefined) missing.push('--asc-issuer-id');
  if (flags['asc-key'] === undefined) missing.push('--asc-key');
  if (missing.length > 0) {
    return `--signing-method requires ${missing.join(', ')}.`;
  }
  return undefined;
}
