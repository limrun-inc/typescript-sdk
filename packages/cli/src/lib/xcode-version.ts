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
 * XcodeInfo plus the daemon's channel, until the @limrun/api release that carries it. "ga" is
 * the Xcode a bare major selects (the lowest installed minor of its major), "beta" every other
 * Xcode of that major. Daemons that predate channels omit it.
 */
export type XcodeInfoWithChannel = XcodeInfo & { channel?: 'ga' | 'beta' };

/**
 * The value a user types to select this Xcode: the bare major for a GA (the daemon resolves a
 * major to its GA), the full version for a beta. Daemons that predate the channel report no
 * channel; they carry one Xcode per major, so the major is the selector there too.
 */
export function xcodeSelectorFor(info: Pick<XcodeInfoWithChannel, 'major' | 'version' | 'channel'>): string {
  return info.channel === 'beta' ? info.version : info.major;
}

/**
 * Whether a saved preference names the sandbox's bound Xcode: a bare major matches the GA of
 * that major, a major.minor matches that exact version. On a daemon without channels a bare
 * major matches its one Xcode of that major.
 */
export function preferenceSelects(
  preferred: string,
  bound: Pick<XcodeInfoWithChannel, 'major' | 'version' | 'channel'>,
): boolean {
  if (preferred.includes('.')) return normalizeMinor(bound.version) === normalizeMinor(preferred);
  return bound.major === preferred && bound.channel !== 'beta';
}

/** "27" and "27.0" name one minor; "26.4.1" belongs to "26.4". */
function normalizeMinor(version: string): string {
  const [major, minor = '0'] = version.split('.');
  return `${Number(major)}.${Number(minor)}`;
}

/** "27.0 (27A5252f)", or "27.0 beta 6 (27A5252f)" for a beta seed. */
export function formatXcodeVersion(info: Pick<XcodeInfo, 'version' | 'build' | 'betaSeed'>): string {
  return `${info.version}${info.betaSeed ? ` beta ${info.betaSeed}` : ''} (${info.build})`;
}

/** formatXcodeVersion plus the node-default mark, falling back to the version key on nodes that report only that. */
export function formatXcode(info: XcodeInfo | undefined): string {
  if (!info) return 'unknown (daemon predates Xcode selection)';
  if (info.version && info.build) {
    return `${formatXcodeVersion(info)}${info.nodeDefault ? ' (node default)' : ''}`;
  }
  return info.versionKey || 'unknown';
}
