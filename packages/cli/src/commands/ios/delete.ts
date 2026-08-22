import { NotFoundError } from '@limrun/api';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { stopDaemon } from '../../lib/daemon';
import { deleteInstancesByLabels } from '../../lib/delete-instances';

export default class IosDelete extends BaseCommand {
  static summary = 'Delete an iOS instance';
  static description = 'Delete iOS instances by ID or labels and remove their cached local metadata.';
  static examples = [
    '<%= config.bin %> ios delete',
    '<%= config.bin %> ios delete <ID>',
    '<%= config.bin %> ios delete ios_abc123',
    '<%= config.bin %> ios delete --label-selector env=ci,team=mobile',
  ];

  static args = {
    id: Args.string({
      description: 'iOS instance ID to delete. Defaults to the last created iOS instance.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'label-selector': Flags.string({
      description:
        'Delete all active instances matching comma-separated labels, for example env=ci,team=mobile',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosDelete);
    this.setParsedFlags(flags);
    if (args.id && flags['label-selector'] !== undefined) {
      this.error('Provide either an iOS instance ID or --label-selector, not both.');
    }

    await this.withAuth(async () => {
      if (flags['label-selector'] !== undefined) {
        const deletedIds = await deleteInstancesByLabels(
          flags['label-selector'],
          (params) => this.client.iosInstances.list(params),
          (id) => this.deleteInstance(id),
        );
        if (deletedIds.length === 0) {
          this.log(`No active iOS instances matched label selector: ${flags['label-selector']}`);
        }
        return;
      }

      const resolvedInstance = this.resolveIosInstance(args.id);
      await this.deleteInstance(resolvedInstance.id);
    });
  }

  private async deleteInstance(id: string): Promise<void> {
    try {
      await this.client.iosInstances.delete(id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
    }

    stopDaemon(id);
    clearLastInstanceId(id);
    this.log(`Deleted iOS instance: ${id}`);
  }
}
