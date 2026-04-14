import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AndroidDelete extends BaseCommand {
  static summary = 'Delete an Android instance';
  static aliases = ['delete android'];
  static examples = ['<%= config.bin %> android delete <ID>'];

  static args = {
    id: Args.string({ description: 'Instance ID to delete', required: true }),
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
