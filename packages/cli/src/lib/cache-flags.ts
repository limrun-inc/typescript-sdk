import { Flags } from '@oclif/core';

/** Cache flags shared by the commands that can create or bind a cache. */
export const cacheFlags = {
  'cache-key': Flags.string({
    description:
      'Key this instance publishes its workspace under when it terminates. Reusing a key replaces its archive. Also used as the restore key when --cache-restore-keys is omitted.',
  }),
  'cache-restore-keys': Flags.string({
    description:
      'Comma-separated keys to restore from, tried in this order: exact match first, then keys starting with the given prefix, newest archive first.',
  }),
  'cache-paths': Flags.string({
    description:
      'Comma-separated project-root-relative paths to cache, such as "Pods,.build". Defaults to the whole workspace. The first publication under a key fixes its path set.',
  }),
};
