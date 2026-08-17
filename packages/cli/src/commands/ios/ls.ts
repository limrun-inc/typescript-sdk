import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { formatBytes } from '../../lib/bytes';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosLs extends BaseCommand {
  static summary = 'List files in the iOS simulator or an app container';
  static description =
    'List a directory in the simulator staging folder. ' +
    'With --bundle-id, the path is relative to that app container instead. ' +
    'Returned paths can be passed directly to ios pull-file, push-file, or delete-file with the same flags.';
  static examples = [
    '<%= config.bin %> ios ls',
    '<%= config.bin %> ios ls Documents --bundle-id com.example.app --container-type data',
    '<%= config.bin %> ios ls Documents --bundle-id com.example.app --container-type data --json',
  ];

  static args = {
    path: Args.string({
      description: 'Relative directory to list. Defaults to the selected storage root.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    'bundle-id': Flags.string({
      description: 'Bundle ID of the installed app whose container should be listed.',
    }),
    'container-type': Flags.string({
      description:
        "Container to target when --bundle-id is provided: 'app', 'data', or a specific App Group identifier. Defaults to 'app'.",
      dependsOn: ['bundle-id'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosLs);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const entries = await client.listFiles(
          args.path,
          flags['bundle-id'] ?
            { bundleId: flags['bundle-id'], containerType: flags['container-type'] }
          : undefined,
        );
        if (flags.json) {
          this.outputJson(entries);
          return;
        }
        this.outputTable(
          ['Type', 'Size', 'Path'],
          entries.map((entry) => [
            entry.isDirectory ? 'directory' : 'file',
            entry.isDirectory ? '' : formatBytes(entry.size ?? 0),
            entry.path,
          ]),
        );
      } finally {
        disconnect();
      }
    });
  }
}
