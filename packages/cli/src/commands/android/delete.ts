import { NotFoundError } from '@limrun/api';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { stopDaemon } from '../../lib/daemon';
import { deleteInstancesByLabels } from '../../lib/delete-instances';

export default class AndroidDelete extends BaseCommand {
  static summary = 'Delete an Android instance';
  static description = 'Delete Android instances by ID or labels.';
  static examples = [
    '<%= config.bin %> android delete',
    '<%= config.bin %> android delete <ID>',
    '<%= config.bin %> android delete android_abc123',
    '<%= config.bin %> android delete --label-selector env=ci,team=mobile',
  ];

  static args = {
    id: Args.string({
      description: 'Android instance ID to delete. Defaults to the last created Android instance.',
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
    const { args, flags } = await this.parse(AndroidDelete);
    this.setParsedFlags(flags);
    if (args.id && flags['label-selector'] !== undefined) {
      this.error('Provide either an Android instance ID or --label-selector, not both.');
    }

    await this.withAuth(async () => {
      if (flags['label-selector'] !== undefined) {
        const deletedIds = await deleteInstancesByLabels(
          flags['label-selector'],
          (params) => this.client.androidInstances.list(params),
          (id) => this.deleteInstance(id),
        );
        if (deletedIds.length === 0) {
          this.log(`No active Android instances matched label selector: ${flags['label-selector']}`);
        }
        return;
      }

      const resolvedInstance = this.resolveAndroidInstance(args.id);
      await this.deleteInstance(resolvedInstance.id);
    });
  }

  private async deleteInstance(id: string): Promise<void> {
    try {
      await this.client.androidInstances.delete(id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
    }

    stopDaemon(id);
    clearLastInstanceId(id);
    this.log(`Deleted Android instance: ${id}`);
  }
}
