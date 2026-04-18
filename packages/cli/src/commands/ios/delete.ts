import { NotFoundError } from '@limrun/api';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearInstanceCache, clearLastInstanceId } from '../../lib/config';
import { stopDaemon } from '../../lib/daemon';

export default class IosDelete extends BaseCommand {
  static summary = 'Delete an iOS instance';
  static description = 'Delete an existing iOS instance by ID and remove any cached local metadata for it.';
  static examples = ['<%= config.bin %> ios delete <ID>', '<%= config.bin %> ios delete ios_abc123'];

  static args = {
    id: Args.string({ description: 'iOS instance ID to delete', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      try {
        await this.client.iosInstances.delete(args.id);
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          throw err;
        }
      }

      stopDaemon(args.id);
      clearLastInstanceId(args.id);
      clearInstanceCache(args.id);
      this.log(`Deleted iOS instance: ${args.id}`);
    });
  }
}
