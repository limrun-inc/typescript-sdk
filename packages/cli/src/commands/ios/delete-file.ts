import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosDeleteFile extends BaseCommand {
  static summary = 'Delete a file or folder on the iOS simulator';
  static description =
    'Delete a file (or folder, recursively) from the simulator sandbox. ' +
    'With --bundle-id, the remote path is a relative path inside that app container instead.';
  static examples = [
    '<%= config.bin %> ios delete-file test.txt',
    '<%= config.bin %> ios delete-file documents/photo.jpeg --bundle-id com.example.app --container-type data',
  ];

  static args = {
    name: Args.string({
      description:
        'Remote filename in the simulator sandbox, or a relative path inside the app container when --bundle-id is provided.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    'bundle-id': Flags.string({
      description: 'Bundle ID of the installed app whose container should be modified.',
    }),
    'container-type': Flags.string({
      description:
        "Container to target when --bundle-id is provided: 'app', 'data', or a specific App Group identifier. Defaults to 'app'.",
      dependsOn: ['bundle-id'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosDeleteFile);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.deleteFile(
          args.name,
          flags['bundle-id'] ?
            { bundleId: flags['bundle-id'], containerType: flags['container-type'] }
          : undefined,
        );
        if (flags.json) {
          this.outputJson({ deleted: args.name });
        } else {
          this.output(`Deleted ${args.name}`);
        }
      } finally {
        disconnect();
      }
    });
  }
}
