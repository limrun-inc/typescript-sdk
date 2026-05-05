import { NotFoundError } from '@limrun/api';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId, clearInstanceCache } from '../../lib/config';
import { stopDaemon } from '../../lib/daemon';

export default class XcodeDelete extends BaseCommand {
  static summary = 'Delete an Xcode instance';
  static description = 'Delete an existing Xcode sandbox instance by ID.';
  static examples = [
    '<%= config.bin %> xcode delete',
    '<%= config.bin %> xcode delete <ID>',
    '<%= config.bin %> xcode delete xcode_abc123',
  ];

  static args = {
    id: Args.string({
      description: 'Xcode instance ID to delete. Defaults to the last created Xcode instance.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
      try {
        await this.client.xcodeInstances.delete(id);
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          throw err;
        }
      }

      stopDaemon(id);
      clearLastInstanceId(id);
      clearInstanceCache(id);
      this.log(`Deleted Xcode instance: ${id}`);
    });
  }
}
