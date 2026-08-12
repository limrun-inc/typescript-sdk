import { NotFoundError } from '@limrun/api';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { deleteInstancesByLabels } from '../../lib/delete-instances';

export default class GradleDelete extends BaseCommand {
  static summary = 'Delete a gradle instance';
  static description = 'Delete gradle build sandbox instances by ID or labels.';
  static examples = [
    '<%= config.bin %> gradle delete',
    '<%= config.bin %> gradle delete <ID>',
    '<%= config.bin %> gradle delete gradle_abc123',
    '<%= config.bin %> gradle delete --label-selector env=ci,team=mobile',
  ];

  static args = {
    id: Args.string({
      description: 'Gradle instance ID to delete. Defaults to the last created gradle instance.',
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
    const { args, flags } = await this.parse(GradleDelete);
    this.setParsedFlags(flags);
    if (args.id && flags['label-selector'] !== undefined) {
      this.error('Provide either a gradle instance ID or --label-selector, not both.');
    }

    await this.withAuth(async () => {
      if (flags['label-selector'] !== undefined) {
        const deletedIds = await deleteInstancesByLabels(
          flags['label-selector'],
          (params) => this.client.gradleInstances.list(params),
          (id) => this.deleteInstance(id),
        );
        if (deletedIds.length === 0) {
          this.log(`No active gradle instances matched label selector: ${flags['label-selector']}`);
        }
        return;
      }

      await this.deleteInstance(this.resolveGradleTarget(args.id).id);
    });
  }

  private async deleteInstance(id: string): Promise<void> {
    try {
      await this.client.gradleInstances.delete(id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
    }

    clearLastInstanceId(id);
    this.log(`Deleted gradle instance: ${id}`);
  }
}
