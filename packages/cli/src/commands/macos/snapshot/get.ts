import { Args } from '@oclif/core';
import { BaseCommand } from '../../../base-command';

export default class MacosSnapshotGet extends BaseCommand {
  static summary = 'Get a macOS snapshot';
  static description =
    'Show a saved macOS disk snapshot: its asset, the macOS build it restores onto, size and checksum.';
  static examples = ['<%= config.bin %> macos snapshot get my-mac'];

  static args = { name: Args.string({ required: true, description: 'Exact snapshot (asset) name.' }) };
  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosSnapshotGet);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const [snapshot] = await this.client.assets.list({
        kindFilter: 'MacOSSnapshot',
        nameFilter: args.name,
      });
      if (!snapshot) this.error(`No macOS snapshot named ${args.name}.`);
      if (flags.json) {
        this.outputJson(snapshot);
        return;
      }
      this.outputTable(
        ['Field', 'Value'],
        [
          ['Name', snapshot.name],
          ['Asset ID', snapshot.id],
          ['macOS', snapshot.metadata?.compatKey ?? ''],
          ['Size (bytes)', String(snapshot.sizeBytes ?? '')],
          ['Uncompressed (bytes)', String(snapshot.metadata?.uncompressedSizeBytes ?? '')],
          ['SHA-256', snapshot.sha256 ?? ''],
          ['Saved at', snapshot.publishedAt ?? ''],
          ['Saved by', snapshot.metadata?.sourceInstanceId ?? ''],
        ],
      );
    });
  }
}
