import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearInstanceCache } from '../../lib/config';

export default class Delete extends BaseCommand {
  static summary = 'Delete a resource by ID (auto-detects type from ID prefix)';
  static description =
    'Delete an Android, iOS, Xcode, sandbox, or asset resource by passing its full ID. The command chooses the correct API based on the ID prefix.';
  static examples = [
    '<%= config.bin %> delete android_abc123',
    '<%= config.bin %> delete ios_abc123',
    '<%= config.bin %> delete xcode_abc123',
    '<%= config.bin %> delete asset_abc123',
  ];

  static args = {
    id: Args.string({
      description: 'Resource ID to delete, such as android_..., ios_..., xcode_..., xcode_..., or asset_...',
      required: true,
    }),
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
          clearInstanceCache(args.id);
          this.log(`Deleted iOS instance: ${args.id}`);
          break;
        case 'xcode':
        case 'sandbox':
          await this.client.xcodeInstances.delete(args.id);
          this.log(`Deleted Xcode instance: ${args.id}`);
          break;
        case 'asset':
          await this.client.assets.delete(args.id);
          this.log(`Deleted asset: ${args.id}`);
          break;
        default:
          this.error(
            `Unknown resource type for ID "${args.id}". Expected prefix: android_, ios_, xcode_, sandbox_, or asset_`,
          );
      }
    });
  }
}
