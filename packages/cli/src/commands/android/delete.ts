import { NotFoundError } from '@limrun/api';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { stopDaemon } from '../../lib/daemon';

export default class AndroidDelete extends BaseCommand {
  static summary = 'Delete an Android instance';
  static description = 'Delete an existing Android instance by ID.';
  static examples = [
    '<%= config.bin %> android delete <ID>',
    '<%= config.bin %> android delete android_abc123',
  ];

  static args = {
    id: Args.string({ description: 'Android instance ID to delete', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      try {
        await this.client.androidInstances.delete(args.id);
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          throw err;
        }
      }

      stopDaemon(args.id);
      clearLastInstanceId(args.id);
      this.log(`Deleted Android instance: ${args.id}`);
    });
  }
}
