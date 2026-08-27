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
  entitlements?: string[];
}

export interface EntitlementsEntry {
  /** Empty string targets the top-level app; the server resolves its bundle id. */
  bundleId: string;
  path: string;
}

// A value is <bundleId>=<path> when the left side of its first '=' looks
// like a reverse-DNS bundle id: bundle-id charset and at least one dot.
// Anything else, including paths containing '=', is a bare path; ./-prefix a
// path to force that reading.
const bundleIDPrefixPattern = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function parseEntitlementsEntries(values: string[]): {
  entries?: EntitlementsEntry[];
  problem?: string;
} {
  const entries: EntitlementsEntry[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let bundleId = '';
    let path = value;
    const eq = value.indexOf('=');
    if (eq > 0) {
      const prefix = value.slice(0, eq);
      if (bundleIDPrefixPattern.test(prefix) && prefix.includes('.')) {
        bundleId = prefix;
        path = value.slice(eq + 1);
      }
    }
    if (path === '') {
      return { problem: `--entitlements ${value} is missing the plist path.` };
    }
    if (seen.has(bundleId)) {
      return {
        problem:
          bundleId === '' ?
            '--entitlements takes at most one bare path (the app); use <bundleId>=<path> for embedded bundles.'
          : `--entitlements provided twice for bundle id ${bundleId}.`,
      };
    }
    seen.add(bundleId);
    entries.push({ bundleId, path });
  }
  return { entries };
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
  if (flags.entitlements !== undefined && flags['signing-method'] === undefined) {
    return '--entitlements requires --signing-method.';
  }
  if (!hasCloudSigningFlags(flags)) {
    return undefined;
  }
  if (flags['signing-method'] === undefined) {
    return '--team-id requires --signing-method.';
  }
  const parsed = parseEntitlementsEntries(flags.entitlements ?? []);
  if (parsed.problem) {
    return parsed.problem;
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
