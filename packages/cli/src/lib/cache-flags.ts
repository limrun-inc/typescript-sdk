import { Flags } from '@oclif/core';

/** Snapshot flags shared by commands that can create or bind a snapshot. */
export const snapshotFlags = {
  'snapshot-key': Flags.string({
    aliases: ['cache-key'],
    description:
      'Key this instance publishes its workspace under when it terminates. Reusing a key replaces its archive. Also used as the restore key when --snapshot-restore-keys is omitted.',
  }),
  'snapshot-restore-keys': Flags.string({
    aliases: ['cache-restore-keys'],
    description:
      'Comma-separated keys to restore from, tried in this order: exact match first, then keys starting with the given prefix, newest archive first.',
  }),
  'snapshot-paths': Flags.string({
    aliases: ['cache-paths'],
    description:
      'Comma-separated project-root-relative paths to snapshot, such as "Pods,.build". Defaults to the whole workspace. The first publication under a key fixes its path set.',
  }),
};

export const waitSnapshotFlag = Flags.boolean({
  aliases: ['wait-cache'],
  description:
    'Wait for the snapshot to finish publishing, reporting each phase. Deletion returns as soon as it is accepted otherwise, while publication continues in the background.',
  default: false,
});
