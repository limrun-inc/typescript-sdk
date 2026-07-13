import { NotFoundError } from '@limrun/api';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';

export default class GradleDelete extends BaseCommand {
  static summary = 'Delete a gradle instance';
  static description = 'Delete an existing gradle build sandbox instance by ID.';
  static examples = [
    '<%= config.bin %> gradle delete',
    '<%= config.bin %> gradle delete <ID>',
    '<%= config.bin %> gradle delete gradle_abc123',
  ];

  static args = {
    id: Args.string({
      description: 'Gradle instance ID to delete. Defaults to the last created gradle instance.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveGradleTarget(args.id).id;
      try {
        await this.client.gradleInstances.delete(id);
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          throw err;
        }
      }

      clearLastInstanceId(id);
      this.log(`Deleted gradle instance: ${id}`);
    });
  }
}
