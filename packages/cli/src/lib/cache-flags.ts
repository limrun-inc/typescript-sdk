import { Flags } from '@oclif/core';

/** Disk snapshot flags shared by commands that can create or bind a snapshot. */
export const snapshotFlags = {
  'no-snapshot': Flags.boolean({
    description: 'Create without a disk snapshot. Existing instances keep their snapshot configuration.',
    exclusive: ['snapshot-key', 'snapshot-restore-keys', 'snapshot-paths'],
  }),
  'snapshot-key': Flags.string({
    aliases: ['cache-key'],
    description:
      'Disk snapshot key to restore and publish at termination. Defaults to the Git origin host/repository plus the project subdirectory for new instances. Reusing a key replaces its archive. Also used to restore when --snapshot-restore-keys is omitted.',
  }),
  'snapshot-restore-keys': Flags.string({
    aliases: ['cache-restore-keys'],
    description:
      'Comma-separated disk snapshot keys to restore from, tried in this order: exact match first, then keys starting with the given prefix, newest archive first.',
  }),
  'snapshot-paths': Flags.string({
    aliases: ['cache-paths'],
    description:
      'Comma-separated project-root-relative paths to include in the disk snapshot, such as "Pods,.build". Defaults to the whole workspace. The first publication under a key fixes its path set.',
  }),
};

export const waitSnapshotFlag = Flags.boolean({
  aliases: ['wait-cache'],
  description:
    'Wait for the disk snapshot to finish publishing, reporting each phase. Deletion returns as soon as it is accepted otherwise, while publication continues in the background.',
  default: false,
});
