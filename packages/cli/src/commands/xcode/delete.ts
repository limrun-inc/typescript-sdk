import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class XcodeDelete extends BaseCommand {
  static summary = 'Delete an Xcode instance';
  static description = 'Delete an existing Xcode sandbox instance by ID.';
  static aliases = ['delete xcode'];
  static examples = ['<%= config.bin %> xcode delete <ID>', '<%= config.bin %> xcode delete xcode_abc123'];

  static args = {
    id: Args.string({ description: 'Xcode instance ID to delete', required: true }),
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
