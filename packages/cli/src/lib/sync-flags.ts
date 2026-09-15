import type { XcodeClient } from '@limrun/api';
import { compileIgnorePatterns } from './ignore-patterns';
import { parseAdditionalFileFlags } from './additional-files';
import { Flags } from '@oclif/core';

/** Source-sync flags shared by the commands that sync a folder before executing. */
export const syncFlags = {
  'basis-cache-dir': Flags.string({
    description: 'Directory to use for the client-side delta sync cache during the sync step.',
  }),
  ignore: Flags.string({
    description:
      'Regular expression to exclude matching relative paths, including .env and .xcconfig files that Xcode sync normally force-includes. If the same path also matches --include, --include wins. Match an excluded parent directory to prune its whole subtree. Repeat for multiple patterns.',
    multiple: true,
    multipleNonGreedy: true,
  }),
  include: Flags.string({
    description:
      'Regular expression to force-sync matching relative paths even when matched by --ignore, excluded by a built-in rule, or ignored by .gitignore (for example --include "^\\\\.git/" or --include "^ios/GeneratedKit/"). The client-side basis cache is never included. If a parent directory is itself excluded, the pattern must also match that directory (e.g. use "^ios/" not "GeneratedKit/") or the subtree stays pruned. Repeat for multiple patterns.',
    multiple: true,
    multipleNonGreedy: true,
  }),
  'additional-file': Flags.string({
    description:
      'Additional file to sync as localPath=remotePath, for example ~/.netrc=.netrc. Repeat for multiple files.',
    multiple: true,
    multipleNonGreedy: true,
  }),
};

type SyncOptions = Parameters<XcodeClient['sync']>[1];

/** Maps the shared sync flags onto a one-shot (no watch, no install) sync call. */
export function syncOptionsFromFlags(flags: {
  'basis-cache-dir'?: string;
  ignore?: string[];
  include?: string[];
  'additional-file'?: string[];
}): SyncOptions {
  return {
    watch: false,
    install: false,
    basisCacheDir: flags['basis-cache-dir'],
    ignore: compileIgnorePatterns(flags.ignore),
    include: compileIgnorePatterns(flags.include),
    additionalFiles: parseAdditionalFileFlags(flags['additional-file']),
  } as SyncOptions;
}
