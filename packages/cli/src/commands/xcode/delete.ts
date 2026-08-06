import { NotFoundError } from '@limrun/api';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { stopDaemon } from '../../lib/daemon';

export default class XcodeDelete extends BaseCommand {
  static summary = 'Delete an Xcode instance';
  static description = 'Delete an existing Xcode sandbox instance by ID.';
  static examples = [
    '<%= config.bin %> xcode delete',
    '<%= config.bin %> xcode delete <ID>',
    '<%= config.bin %> xcode delete xcode_abc123',
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = await this.resolveXcodeTarget(args.id);
      const id = resolvedInstance.id;
      // Subscribed, and subscribed *before* the delete, so a publication that is over in
      // seconds is still seen. The stream takes a moment to open and an instance with nothing
      // to publish is collected in about as long, which is a race the watcher loses in silence:
      // the endpoint answers from the region, so it is a 404 by the time the stream gets there.
      const following =
        flags['wait-cache'] ?
          this.startCachePublicationFollow(this.cacheInstanceId(resolvedInstance))
        : undefined;
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
    });
  }
}
