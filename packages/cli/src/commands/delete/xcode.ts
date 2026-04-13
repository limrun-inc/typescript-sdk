import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class DeleteXcode extends BaseCommand {
  static summary = 'Delete a Xcode instance';
  static examples = ['<%= config.bin %> delete xcode <ID>'];

  static args = {
    id: Args.string({ description: 'Instance ID to delete', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DeleteXcode);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      await this.client.xcodeInstances.delete(args.id);
      this.log(`Deleted Xcode instance: ${args.id}`);
    });
  }
}
