import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AndroidGet extends BaseCommand {
  static summary = 'Get details for a specific Android instance';
  static description =
    'Fetch detailed metadata for a single Android instance, including region, state, and display name. Use `--json` to inspect the full API response.';
  static aliases = ['get android', 'get a'];
  static examples = ['<%= config.bin %> android get <ID>', '<%= config.bin %> android get <ID> --json'];

  static args = {
    id: Args.string({ description: 'Android instance ID to fetch', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidGet);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const instance = await this.client.androidInstances.get(args.id);
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
