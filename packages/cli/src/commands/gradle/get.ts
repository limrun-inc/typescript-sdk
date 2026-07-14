import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { loadLastGradleInstance } from '../../lib/config';

export default class GradleGet extends BaseCommand {
  static summary = 'Get a gradle instance';
  static description =
    'Show details of a gradle build sandbox instance by ID. Falls back to listing all gradle instances when no ID is given and no recent target is remembered.';
  static examples = ['<%= config.bin %> gradle get', '<%= config.bin %> gradle get <ID>'];

  static args = {
    id: Args.string({
      description:
        'Gradle instance ID. Defaults to the last used gradle instance; lists all instances when none is remembered.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleGet);
    this.setParsedFlags(flags);

    if (!args.id && !loadLastGradleInstance()) {
      this.info('No recent gradle target found. Listing gradle instances instead.');
      await this.runListFallback('gradle:list');
      return;
    }

    await this.withAuth(async () => {
      const target = this.resolveGradleTarget(args.id);
      const instance = await this.client.gradleInstances.get(target.id);

      if (flags.json) {
        this.outputJson(instance);
        return;
      }
      this.outputTable(
        ['ID', 'Name', 'Region', 'State'],
        [
          [
            instance.metadata.id,
            instance.metadata.displayName || '',
            instance.spec.region,
            instance.status.state,
          ],
        ],
      );
    });
  }
}
