import { Flags } from '@oclif/core';

/** Snapshot settings shared by Xcode and Gradle builds. */
export const buildSnapshotFlags = {
  'no-snapshot': Flags.boolean({
    description: 'Create without a disk snapshot. Existing instances keep their snapshot configuration.',
    exclusive: ['snapshot-key', 'snapshot-restore-keys', 'snapshot-ttl'],
  }),
  'snapshot-ttl': Flags.string({
    description:
      'Expire the saved disk snapshot after this duration from publication, for example 12h or 7d. Defaults to 30 days.',
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
};

/** Xcode also supports saving selected workspace paths. */
export const snapshotFlags = {
  ...buildSnapshotFlags,
  'snapshot-paths': Flags.string({
    aliases: ['cache-paths'],
    exclusive: ['no-snapshot'],
    description:
      'Comma-separated project-root-relative paths to include in the disk snapshot, such as "Pods". Defaults to the whole workspace. A restore can land at a different absolute path, so include only content that works anywhere: path-keyed state such as DerivedData or SwiftPM .build rebuilds from scratch. The first publication under a key fixes its path set.',
  }),
};

/**
 * macOS disk snapshot flags. Like Gradle's, a macOS snapshot keeps a fixed set of state (what the
 * guest changed since it started), so there are no paths, and snapshots are opt-in.
 */
export const macosSnapshotFlags = {
  'snapshot-key': Flags.string({
    description:
      'Asset name the instance saves its disk snapshot under when it terminates, and restores from when --snapshot-restore-keys is omitted. The snapshot keeps every file the guest changed since it started: the home directory, installed apps and tools. The instance gets the asset permissions it needs.',
  }),
  'snapshot-restore-keys': Flags.string({
    description:
      'Comma-separated snapshot asset names to restore from, tried in this order: exact name first, then the newest name starting with it. A snapshot saved on another macOS build is skipped for the next key.',
  }),
};

export const waitSnapshotFlag = Flags.boolean({
  aliases: ['wait-cache'],
  description:
    'Wait for the disk snapshot to finish publishing, reporting each phase. Deletion returns as soon as it is accepted otherwise, while publication continues in the background.',
  default: false,
});
