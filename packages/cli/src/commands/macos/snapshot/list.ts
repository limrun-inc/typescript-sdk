import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { formatBytes } from '../../../lib/bytes';

export default class MacosSnapshotList extends BaseCommand {
  static summary = 'List macOS snapshots';
  static description =
    'List saved macOS disk snapshots, the assets of kind MacOSSnapshot your credential can read, newest first.';
  static examples = [
    '<%= config.bin %> macos snapshot list',
    '<%= config.bin %> macos snapshot list --prefix my-',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    prefix: Flags.string({ description: 'Only snapshots whose name starts with this literal prefix.' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosSnapshotList);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const snapshots = await this.client.assets.list({
        kindFilter: 'MacOSSnapshot',
        ...(flags.prefix && { namePrefixFilter: flags.prefix }),
      });
      if (flags.json) {
        this.outputJson(snapshots);
        return;
      }
      this.outputTable(
        ['Name', 'macOS', 'Size', 'Saved at'],
        snapshots.map((s) => [
          s.name,
          s.metadata?.compatKey ?? '',
          s.sizeBytes ? formatBytes(s.sizeBytes) : 'Not saved',
          s.publishedAt ?? '',
        ]),
      );
    });
  }
}
