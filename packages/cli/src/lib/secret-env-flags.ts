import { Flags } from '@oclif/core';

export const secretEnvFlags = {
  'file-from-secret': Flags.string({
    description:
      "Use a stored credential file, for example '~/.npmrc=packages/npmrc' or '~/.netrc=github/netrc'. Quote ~/ for the remote home. Command bindings are removed on completion or failure; create saves defaults. Existing files are not overwritten.",
    multiple: true,
    multipleNonGreedy: true,
  }),
  'env-from-secret': Flags.string({
    description:
      'Set an environment variable from a stored secret: NAME=secret/name or NAME=secret_TID. Repeat for multiple variables.',
    multiple: true,
    multipleNonGreedy: true,
  }),
};
