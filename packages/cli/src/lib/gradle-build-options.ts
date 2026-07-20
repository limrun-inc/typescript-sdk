import type { GradleAndroidABI, GradleBuildOptions } from '@limrun/api';

/**
 * Single source for the --abi enum: `satisfies` pins every entry to the SDK
 * union, so a server-side rename surfaces here at compile time instead of
 * drifting silently behind an unchecked cast.
 */
export const gradleAndroidABIs = [
  'armeabi-v7a',
  'arm64-v8a',
  'x86',
  'x86_64',
  'all',
] as const satisfies readonly GradleAndroidABI[];

export interface GradleBuildFlagValues {
  task?: string[];
  'project-path'?: string;
  'expo-app-dir'?: string;
  abi?: string[];
  upload?: string;
  'signed-upload-url'?: string;
  sign?: boolean;
  'application-id'?: string;
  keystore?: string;
  'keystore-password'?: string;
  'key-alias'?: string;
  'key-password'?: string;
  'save-key'?: boolean;
}

const byoSigningFlags = ['keystore', 'keystore-password', 'key-alias', 'key-password'] as const;

/**
 * Validates the signing flag combinations. Separate from the options
 * mapping because signing material is resolved asynchronously (file read
 * or escrow round-trip) after validation, while the mapper stays pure.
 */
export function validateSigningFlags(flags: GradleBuildFlagValues): void {
  const byoGiven = byoSigningFlags.filter((f) => flags[f]);
  if (flags.sign && byoGiven.length > 0) {
    throw new Error('Use either --sign (escrowed key) or --keystore (bring your own key), not both.');
  }
  if (byoGiven.length > 0 && byoGiven.length < byoSigningFlags.length) {
    const missing = byoSigningFlags.filter((f) => !flags[f]);
    throw new Error(`Signing with your own key requires ${missing.map((f) => `--${f}`).join(', ')} as well.`);
  }
  if (flags['save-key'] && byoGiven.length === 0) {
    throw new Error('--save-key escrows a provided key and requires the --keystore flags.');
  }
  if (flags['application-id'] && !flags.sign && !flags['save-key']) {
    throw new Error('--application-id only applies to --sign or --save-key.');
  }
}

/**
 * Maps parsed `lim gradle build` flags to the exec options, throwing on
 * contradictory combinations. Pure and oclif-free so it is unit-testable and
 * so the command can validate BEFORE resolving (and possibly auto-creating)
 * an instance: a doomed flag combination must not leave a billed instance
 * behind. `reactNative` is set only when a flag asks for it; its absence is
 * what lets the server auto-detect.
 */
export function gradleBuildOptionsFromFlags(flags: GradleBuildFlagValues): GradleBuildOptions {
  if (flags.upload && flags['signed-upload-url']) {
    throw new Error('Use either --upload or --signed-upload-url, not both.');
  }
  validateSigningFlags(flags);
  const options: GradleBuildOptions = {};
  if (flags.task?.length) {
    options.tasks = flags.task;
  }
  if (flags['project-path']) {
    options.projectPath = flags['project-path'];
  }
  const expoAppDir = flags['expo-app-dir'];
  const abis = flags.abi?.length ? ([...new Set(flags.abi)] as GradleAndroidABI[]) : undefined;
  if (abis?.includes('all') && abis.some((abi) => abi !== 'all')) {
    throw new Error(
      "--abi all keeps the project's own ABI configuration and cannot be combined with specific ABIs.",
    );
  }
  if (expoAppDir || abis) {
    options.reactNative = {
      ...(expoAppDir && { expoAppDir }),
      ...(abis && { architectures: abis }),
    };
  }
  if (flags.upload) {
    options.upload = { assetName: flags.upload };
  } else if (flags['signed-upload-url']) {
    options.upload = { signedUploadUrl: flags['signed-upload-url'] };
  }
  return options;
}
