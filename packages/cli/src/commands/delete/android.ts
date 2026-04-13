import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class DeleteAndroid extends BaseCommand {
  static summary = 'Delete an Android instance';
  static examples = ['<%= config.bin %> delete android <ID>'];

  static args = {
    id: Args.string({ description: 'Instance ID to delete', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DeleteAndroid);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      await this.client.androidInstances.delete(args.id);
      this.log(`Deleted Android instance: ${args.id}`);
    });
  }
}
