import { Flags } from '@oclif/core';
import type { XcodeInfo } from '@limrun/api';
import { loadXcodeVersionPreference } from './config';

/** The one-shot Xcode major override shared by create, build, test and rbe. */
export const xcodeVersionFlags = {
  'xcode-version': Flags.string({
    description:
      'Xcode major to build with for this invocation, e.g. 27 (see `lim xcode version list`). Overrides the ' +
      "workspace preference set with `lim xcode version set` without changing it. Switching resets the sandbox's DerivedData.",
    helpValue: '<major>',
  }),
};

/** Target selection for the `version` commands: an explicit sandbox, never an auto-created one. */
export const xcodeTargetFlags = {
  id: Flags.string({
    description: 'Xcode instance ID to target. Defaults to the most recently created Xcode-capable target.',
  }),
};

const majorPattern = /^\d+$/;

/** Rejects anything but a bare major such as "27", before any network call. */
export function parseXcodeMajor(value: string, source = '--xcode-version'): string {
  if (!majorPattern.test(value)) {
    throw new Error(`${source} takes an Xcode major such as 27 (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** How a requested Xcode major was chosen, for the notice printed before a switch. */
export type RequestedXcodeVersion = { major: string; source: 'flag' | 'workspace' };

/**
 * The Xcode major a command should make its sandbox use: the flag when given, else the
 * workspace preference, else nothing (the sandbox keeps its selected Xcode).
 */
export function resolveRequestedXcodeVersion(flag: string | undefined): RequestedXcodeVersion | undefined {
  if (flag) return { major: parseXcodeMajor(flag), source: 'flag' };
  const preferred = loadXcodeVersionPreference();
  return preferred ? { major: preferred, source: 'workspace' } : undefined;
}

/** "27.0 (27A5252f)", falling back to the version key on nodes that report only that. */
export function formatXcode(info: XcodeInfo | undefined): string {
  if (!info) return 'unknown (daemon predates Xcode selection)';
  if (info.version && info.build) {
    return `${info.version} (${info.build})${info.nodeDefault ? ' (node default)' : ''}`;
  }
  return info.versionKey || 'unknown';
}

/**
 * Notes column of `lim xcode version list`: beta seed, selection, node default, workspace
 * preference.
 * TODO(turkenh): drop the `betaSeed` intersection once package.json depends on @limrun/api
 * >= 0.49.2; the publish type-check runs against the installed package, which lacks the field.
 */
export function xcodeNotes(
  info: XcodeInfo & { betaSeed?: string },
  selectedMajor: string,
  preferredMajor: string | null | undefined,
): string {
  return [
    info.betaSeed ? `beta ${info.betaSeed}` : '',
    info.major === selectedMajor ? 'selected' : '',
    info.nodeDefault ? 'default' : '',
    info.major === preferredMajor ? 'preferred' : '',
  ]
    .filter(Boolean)
    .join(', ');
}
