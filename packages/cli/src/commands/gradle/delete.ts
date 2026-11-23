import { NotFoundError } from '@limrun/api';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { waitSnapshotFlag } from '../../lib/cache-flags';

export default class GradleDelete extends BaseCommand {
  static summary = 'Delete a gradle instance';
  static description = 'Delete an existing gradle build sandbox instance by ID.';
  static examples = [
    '<%= config.bin %> gradle delete',
    '<%= config.bin %> gradle delete <ID>',
    '<%= config.bin %> gradle delete gradle_abc123',
    '<%= config.bin %> gradle delete --wait-snapshot',
  ];

  static args = {
    id: Args.string({
      description: 'Gradle instance ID to delete. Defaults to the last created gradle instance.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags, 'wait-snapshot': waitSnapshotFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveGradleTarget(args.id).id;
      // Subscribed before the delete, so a save that is over in seconds is still seen.
      const following = flags['wait-snapshot'] ? this.startCachePublicationFollow(id, 'gradle') : undefined;
      await following?.opened;
      try {
        await this.client.gradleInstances.delete(id);
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          throw err;
        }
      }

      clearLastInstanceId(id);
      // The instance is held until its snapshot is saved, so the save is reported first.
      const published = following ? await this.renderCachePublication(following) : true;
      if (!published) {
        this.error('The snapshot was not published.');
      }
      this.outputResult({ ok: true, id }, `Deleted gradle instance: ${id}`);
    });
  }
}
