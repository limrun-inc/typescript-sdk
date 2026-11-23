import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { loadLastMacosInstance } from '../../lib/config';

export default class MacosGet extends BaseCommand {
  static summary = 'Get a macOS instance';
  static description =
    'Show details of a macOS instance by ID. Falls back to listing macOS instances when no ID is given and no recent instance is remembered.';
  static examples = ['<%= config.bin %> macos get', '<%= config.bin %> macos get <ID>'];

  static args = {
    id: Args.string({
      description:
        'macOS instance ID. Defaults to the last created macOS instance; lists instances when none is remembered.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosGet);
    this.setParsedFlags(flags);

    if (!args.id && !loadLastMacosInstance()) {
      this.info('No recent macOS instance found. Listing macOS instances instead.');
      await this.runListFallback('macos:list');
      return;
    }

    await this.withAuth(async () => {
      const instance = await this.client.macosInstances.get(this.resolveMacosTarget(args.id).id);
      if (flags.json) {
        this.outputJson(instance);
        return;
      }
      this.outputTable(
        ['ID', 'Name', 'Region', 'State', 'Console URL'],
        [
          [
            instance.metadata.id,
            instance.metadata.displayName || '',
            instance.spec.region,
            instance.status.state,
            this.consoleStreamUrl(instance.metadata.id),
          ],
        ],
      );
    });
  }
}
