import { Args } from '@oclif/core';
import { BaseCommand } from '../../../base-command';

export default class MacosSnapshotDelete extends BaseCommand {
  static summary = 'Delete a macOS snapshot';
  static description =
    'Permanently delete a saved macOS disk snapshot, its asset and archive. A running instance with this key saves it again when it terminates.';
  static examples = ['<%= config.bin %> macos snapshot delete my-mac'];

  static args = { name: Args.string({ required: true, description: 'Exact snapshot (asset) name.' }) };
  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosSnapshotDelete);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const [snapshot] = await this.client.assets.list({
        kindFilter: 'MacOSSnapshot',
        nameFilter: args.name,
      });
      if (!snapshot) this.error(`No macOS snapshot named ${args.name}.`);
      await this.client.assets.delete(snapshot.id);
      this.outputResult(
        { ok: true, name: args.name, id: snapshot.id },
        `Deleted macOS snapshot ${args.name}`,
      );
    });
  }
}
