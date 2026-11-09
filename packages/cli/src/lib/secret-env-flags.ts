import { Flags } from '@oclif/core';

export const secretEnvFlags = {
  'env-from-secret': Flags.string({
    description:
      'Set an environment variable from a stored secret: NAME=secret/name or NAME=secret_TID. Repeat for multiple variables.',
    multiple: true,
    multipleNonGreedy: true,
  }),
};
