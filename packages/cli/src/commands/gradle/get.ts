import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class GradleGet extends BaseCommand {
  static summary = 'Get a gradle instance';
  static description = 'Show details of a gradle build sandbox instance by ID.';
  static examples = ['<%= config.bin %> gradle get', '<%= config.bin %> gradle get <ID>'];

  static args = {
    id: Args.string({
      description: 'Gradle instance ID. Defaults to the last used gradle instance.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleGet);
    this.setParsedFlags(flags);

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
