import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosPullFile extends BaseCommand {
  static summary = 'Pull a file from the iOS simulator';
  static description =
    'Download a file from the simulator sandbox and save it locally. ' +
    'With --bundle-id, the remote path is a relative path inside that app container instead.';
  static examples = [
    '<%= config.bin %> ios pull-file test.txt',
    '<%= config.bin %> ios pull-file documents/photo.jpeg ./photo.jpeg --bundle-id com.example.app --container-type data',
    '<%= config.bin %> ios pull-file test.txt ./downloaded.txt --json',
  ];

  static args = {
    name: Args.string({
      description:
        'Remote filename in the simulator sandbox, or a relative path inside the app container when --bundle-id is provided.',
      required: true,
    }),
    path: Args.string({
      description:
        'Local path to save the file to. Defaults to the remote filename in the current directory.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    'bundle-id': Flags.string({
      description: 'Bundle ID of the installed app whose container should be read.',
    }),
    'container-type': Flags.string({
      description:
        "Container to target when --bundle-id is provided: 'app', 'data', or a specific App Group identifier. Defaults to 'app'.",
      dependsOn: ['bundle-id'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosPullFile);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);

      const localPath = path.resolve(args.path ?? path.basename(args.name));

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const content = await client.pullFile(
          args.name,
          flags['bundle-id'] ?
            { bundleId: flags['bundle-id'], containerType: flags['container-type'] }
          : undefined,
        );
        fs.writeFileSync(localPath, content);
        if (flags.json) {
          this.outputJson({ localPath, bytes: content.length });
        } else {
          this.output(localPath);
        }
      } finally {
        disconnect();
      }
    });
  }
}
