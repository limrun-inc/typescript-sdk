import { NotFoundError } from '@limrun/api';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { stopDaemon } from '../../lib/daemon';
import { deleteInstancesByLabels } from '../../lib/delete-instances';

export default class XcodeDelete extends BaseCommand {
  static summary = 'Delete an Xcode instance';
  static description = 'Delete Xcode sandbox instances by ID or labels.';
  static examples = [
    '<%= config.bin %> xcode delete',
    '<%= config.bin %> xcode delete <ID>',
    '<%= config.bin %> xcode delete xcode_abc123',
    '<%= config.bin %> xcode delete --label-selector env=ci,team=mobile',
    '<%= config.bin %> xcode delete --wait-cache',
  ];

  static args = {
    id: Args.string({
      description: 'Xcode instance ID to delete. Defaults to the last created Xcode instance.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'wait-cache': Flags.boolean({
      description:
        'Wait for the build cache to finish publishing, reporting each phase. Deletion returns as soon as it is accepted otherwise, while publication continues in the background.',
      default: false,
    }),
    'label-selector': Flags.string({
      description:
        'Delete all active instances matching comma-separated labels, for example env=ci,team=mobile',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeDelete);
    this.setParsedFlags(flags);
    if (args.id && flags['label-selector'] !== undefined) {
      this.error('Provide either an Xcode instance ID or --label-selector, not both.');
    }

    await this.withAuth(async () => {
      if (flags['label-selector'] !== undefined) {
        const deletedIds = await deleteInstancesByLabels(
          flags['label-selector'],
          (params) => this.client.xcodeInstances.list(params),
          (id) => this.deleteInstance(id, flags['wait-cache']),
        );
        if (deletedIds.length === 0) {
          this.log(`No active Xcode instances matched label selector: ${flags['label-selector']}`);
        }
        return;
      }

      await this.deleteInstance(args.id, flags['wait-cache']);
    });
  }

  private async deleteInstance(providedId: string | undefined, waitCache: boolean): Promise<void> {
    const resolvedInstance = await this.resolveXcodeTarget(providedId);
    const id = resolvedInstance.id;
    // Subscribed, and subscribed *before* the delete, so a publication that is over in
    // seconds is still seen. The stream takes a moment to open and an instance with nothing
    // to publish is collected in about as long, which is a race the watcher loses in silence:
    // the endpoint answers from the region, so it is a 404 by the time the stream gets there.
    const following =
      waitCache ? this.startCachePublicationFollow(this.cacheInstanceId(resolvedInstance)) : undefined;
    await following?.opened;
    try {
      await this.client.xcodeInstances.delete(id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err;
      }
    }

    stopDaemon(id);
    clearLastInstanceId(id);

    // The deletion line comes after the publication rather than before it, both so the phases
    // read as one block and because that is the order the two actually finish in: the instance
    // is held open until its workspace has been published.
    const published = following ? await this.renderCachePublication(following) : true;
    this.log(`Deleted Xcode instance: ${id}`);
    if (!published) {
      this.error('The build cache was not published.');
    }
  }
}
