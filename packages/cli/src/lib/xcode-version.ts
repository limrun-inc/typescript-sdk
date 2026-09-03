import { Flags } from '@oclif/core';
import type { XcodeInfo } from '@limrun/api';

/** The Xcode major selector shared by create, build, test and rbe. */
export const xcodeVersionFlags = {
  'xcode-version': Flags.string({
    description:
      'Xcode major to build with, e.g. 27 (see `lim xcode list-xcode`). Switches the sandbox when it is bound to another major, which resets its DerivedData. Defaults to the sandbox default.',
    helpValue: '<major>',
  }),
};

const majorPattern = /^\d+$/;

/** Rejects anything but a bare major such as "27", before any network call. */
export function parseXcodeMajor(value: string): string {
  if (!majorPattern.test(value)) {
    throw new Error(`--xcode-version takes an Xcode major such as 27 (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** "27.0 (27A5252f)", falling back to the version key on nodes that report only that. */
export function formatXcode(info: XcodeInfo | undefined): string {
  if (!info) return 'unknown (daemon predates Xcode selection)';
  if (info.version && info.build) {
    return `${info.version} (${info.build})${info.nodeDefault ? ' (node default)' : ''}`;
  }
  return info.versionKey || 'unknown';
}
