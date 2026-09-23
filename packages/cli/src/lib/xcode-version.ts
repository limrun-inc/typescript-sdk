import { Flags } from '@oclif/core';
import type { XcodeInfo } from '@limrun/api';
import { loadXcodeVersionPreference } from './config';

/** The one-shot Xcode selection shared by create, build, test and rbe. */
export const xcodeVersionFlags = {
  'xcode-version': Flags.string({
    description:
      "Xcode to build with for this invocation: a major such as 27 (that major's GA release) or a major.minor such as " +
      '27.1 (an exact version, typically a beta); see `lim xcode version list`. Overrides the workspace preference set ' +
      'with `lim xcode version set` without changing it. Switching invalidates the build cache from the other version, ' +
      'so the next build starts cold.',
    helpValue: '<major|major.minor>',
  }),
};

/** Target selection for the `version` commands: an explicit sandbox, never an auto-created one. */
export const xcodeTargetFlags = {
  id: Flags.string({
    description: 'Xcode instance ID to target. Defaults to the most recently created Xcode-capable target.',
  }),
};

/**
 * What the daemon accepts: a bare major ("27", resolves to that major's GA) or a major.minor
 * ("27.1", an exact version). Shared with the saved workspace preference so a value that passes
 * here is never dropped on read.
 */
export const XCODE_SELECTOR_PATTERN = /^\d+(\.\d+)?$/;

/** Rejects anything but a major or major.minor such as "27" or "27.1", before any network call. */
export function parseXcodeVersion(value: string, source = '--xcode-version'): string {
  if (!XCODE_SELECTOR_PATTERN.test(value)) {
    throw new Error(
      `${source} takes an Xcode major such as 27 or major.minor such as 27.1 (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** How a requested Xcode version was chosen, for the notice printed before a switch. */
export type RequestedXcodeVersion = { version: string; source: 'flag' | 'workspace' };

/**
 * The Xcode a command should make its sandbox use: the flag when given, else the workspace
 * preference, else nothing (the sandbox keeps its selected Xcode).
 */
export function resolveRequestedXcodeVersion(flag: string | undefined): RequestedXcodeVersion | undefined {
  if (flag) return { version: parseXcodeVersion(flag), source: 'flag' };
  const preferred = loadXcodeVersionPreference();
  return preferred ? { version: preferred, source: 'workspace' } : undefined;
}

/**
 * XcodeInfo plus the daemon's channel, until the @limrun/api release that carries it. "beta"
 * marks Apple's developer seeds and GM seeds Apple has not released; "ga" a released build, the
 * only kind a bare major binds to. Daemons that predate channels omit it.
 */
export type XcodeInfoWithChannel = XcodeInfo & { channel?: 'ga' | 'beta' };

type XcodeIdentity = Pick<XcodeInfoWithChannel, 'major' | 'version' | 'channel' | 'developerDir'>;

/**
 * The value a user types to select this Xcode. The daemon binds a bare major to the newest GA
 * of that major, so that one Xcode is selected by its major; every other Xcode, a beta or an
 * older GA kept beside a newer one, needs its exact version. Daemons that predate the channel
 * report none and carry one Xcode per major, so the major selects it there too.
 */
export function xcodeSelectorFor(info: XcodeIdentity, installed: readonly XcodeIdentity[]): string {
  if (info.channel === 'beta') return info.version;
  const newestGA = installed
    .filter((x) => x.major === info.major && x.channel !== 'beta')
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  return !newestGA || newestGA.developerDir === info.developerDir ? info.major : info.version;
}

/**
 * Whether a saved preference names the sandbox's bound Xcode: a bare major matches the GA it
 * would bind, a major.minor matches that exact version.
 */
export function preferenceSelects(
  preferred: string,
  bound: XcodeIdentity,
  installed: readonly XcodeIdentity[],
): boolean {
  if (preferred.includes('.')) return normalizeMinor(bound.version) === normalizeMinor(preferred);
  return xcodeSelectorFor(bound, installed) === preferred;
}

/** "27" and "27.0" name one minor; "26.4.1" belongs to "26.4". */
function normalizeMinor(version: string): string {
  const [major, minor = '0'] = version.split('.');
  return `${Number(major)}.${Number(minor)}`;
}

/** Numeric, component by component, so "26.10" sorts after "26.4". */
function compareVersions(a: string, b: string): number {
  const as = a.split('.').map(Number);
  const bs = b.split('.').map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Oldest first, the order a version list reads in; daemons before the sort listed the node default first. */
export function sortXcodesByVersion<T extends Pick<XcodeInfo, 'version'>>(xcodes: readonly T[]): T[] {
  return [...xcodes].sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * "27.0 (27A5252f)", "27.0 beta 6 (27A5252f)" for a seed with a number, "27.1 beta (27A9269)"
 * for a beta without one: the word appears wherever a beta is shown or selected, since the
 * version alone does not say so.
 */
export function formatXcodeVersion(
  info: Pick<XcodeInfoWithChannel, 'version' | 'build' | 'betaSeed' | 'channel'>,
): string {
  const beta =
    info.betaSeed ? ` beta ${info.betaSeed}`
    : info.channel === 'beta' ? ' beta'
    : '';
  return `${info.version}${beta} (${info.build})`;
}

/** formatXcodeVersion plus the node-default mark, falling back to the version key on nodes that report only that. */
export function formatXcode(info: XcodeInfoWithChannel | undefined): string {
  if (!info) return 'unknown (daemon predates Xcode selection)';
  if (info.version && info.build) {
    return `${formatXcodeVersion(info)}${info.nodeDefault ? ' (node default)' : ''}`;
  }
  return info.versionKey || 'unknown';
}
