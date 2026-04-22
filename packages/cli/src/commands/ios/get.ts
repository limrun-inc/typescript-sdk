import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class IosGet extends BaseCommand {
  static summary = 'Get details for a specific iOS instance';
  static description =
    'Fetch detailed metadata for a single iOS instance, including region, state, and display name. Use `--json` to inspect the full API response.';
  static examples = ['<%= config.bin %> ios get <ID>', '<%= config.bin %> ios get <ID> --json'];

  static args = {
    id: Args.string({ description: 'iOS instance ID to fetch', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosGet);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const instance = await this.client.iosInstances.get(args.id);
      if (flags.json) {
        this.outputJson(instance);
      } else {
        const signedStreamUrl = this.signedStreamUrl(instance.status);
        this.outputTable(
          ['Field', 'Value'],
          [
            ['ID', instance.metadata.id],
            ['Name', instance.metadata.displayName || ''],
            ['Region', instance.spec.region],
            ['State', instance.status.state],
            ...(signedStreamUrl ? [['Signed Stream URL', signedStreamUrl]] : []),
          ],
        );
      }
    });
  }
}
