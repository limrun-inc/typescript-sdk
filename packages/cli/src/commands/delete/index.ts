import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class Delete extends BaseCommand {
  static summary = 'Delete a resource by ID (auto-detects type from ID prefix)';
  static examples = [
    '<%= config.bin %> delete android_abc123',
    '<%= config.bin %> delete ios_abc123',
    '<%= config.bin %> delete xcode_abc123',
  ];

  static args = {
    id: Args.string({ description: 'Resource ID to delete', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Delete);
    this.setParsedFlags(flags);

    const prefix = args.id.split('_')[0];

    await this.withAuth(async () => {
      switch (prefix) {
        case 'android':
          await this.client.androidInstances.delete(args.id);
          this.log(`Deleted Android instance: ${args.id}`);
          break;
        case 'ios':
          await this.client.iosInstances.delete(args.id);
          this.log(`Deleted iOS instance: ${args.id}`);
          break;
        case 'xcode':
          await this.client.xcodeInstances.delete(args.id);
          this.log(`Deleted Xcode instance: ${args.id}`);
          break;
        case 'asset':
          await this.client.assets.delete(args.id);
          this.log(`Deleted asset: ${args.id}`);
          break;
        default:
          this.error(`Unknown resource type for ID "${args.id}". Expected prefix: android_, ios_, xcode_, or asset_`);
      }
    });
  }
}
