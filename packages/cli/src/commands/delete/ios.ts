import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearInstanceCache } from '../../lib/config';

export default class DeleteIos extends BaseCommand {
  static summary = 'Delete an iOS instance';
  static examples = ['<%= config.bin %> delete ios <ID>'];

  static args = {
    id: Args.string({ description: 'Instance ID to delete', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DeleteIos);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      await this.client.iosInstances.delete(args.id);
      clearInstanceCache(args.id);
      this.log(`Deleted iOS instance: ${args.id}`);
    });
  }
}
