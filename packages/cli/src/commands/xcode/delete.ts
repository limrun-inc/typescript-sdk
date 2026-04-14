import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class XcodeDelete extends BaseCommand {
  static summary = 'Delete a Xcode instance';
  static aliases = ['delete xcode'];
  static examples = ['<%= config.bin %> xcode delete <ID>'];

  static args = {
    id: Args.string({ description: 'Instance ID to delete', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      await this.client.xcodeInstances.delete(args.id);
      this.log(`Deleted Xcode instance: ${args.id}`);
    });
  }
}
