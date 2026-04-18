import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AssetDelete extends BaseCommand {
  static summary = 'Delete an asset';
  static description = 'Delete an uploaded asset by ID.';
  static examples = ['<%= config.bin %> asset delete <ID>', '<%= config.bin %> asset delete asset_abc123'];

  static args = {
    id: Args.string({ description: 'Asset ID to delete', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AssetDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      await this.client.assets.delete(args.id);
      this.log(`Deleted asset: ${args.id}`);
    });
  }
}
