import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class XcodeGet extends BaseCommand {
  static summary = 'Get details for a specific Xcode instance';
  static description =
    'Fetch detailed metadata for a single Xcode sandbox instance, including region, state, and display name. Use `--json` to inspect the full API response.';
  static aliases = ['get xcode'];
  static examples = ['<%= config.bin %> xcode get <ID>', '<%= config.bin %> xcode get <ID> --json'];

  static args = {
    id: Args.string({ description: 'Xcode instance ID to fetch', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeGet);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const instance = await this.client.xcodeInstances.get(args.id);
      if (flags.json) {
        this.outputJson(instance);
      } else {
        this.outputTable(
          ['Field', 'Value'],
          [
            ['ID', instance.metadata.id],
            ['Name', instance.metadata.displayName || ''],
            ['Region', instance.spec.region],
            ['State', instance.status.state],
          ],
        );
      }
    });
  }
}
