import { Flags } from '@oclif/core';
import type { XcodeInfo } from '@limrun/api';
import { loadXcodeVersionPreference } from './config';

/** The one-shot Xcode major override shared by create, build, test and rbe. */
export const xcodeVersionFlags = {
  'xcode-version': Flags.string({
    description:
      'Xcode major to build with for this invocation, e.g. 27 (see `lim xcode version list`). Overrides the ' +
      'workspace preference set with `lim xcode version set` without changing it. Switching invalidates the build cache from the other version, so the next build starts cold.',
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
