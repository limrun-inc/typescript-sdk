import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AndroidDelete extends BaseCommand {
  static summary = 'Delete an Android instance';
  static description = 'Delete an existing Android instance by ID.';
  static aliases = ['delete android'];
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
      await this.client.androidInstances.delete(args.id);
      this.log(`Deleted Android instance: ${args.id}`);
    });
  }
}
