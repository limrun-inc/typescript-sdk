import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosPushFile extends BaseCommand {
  static summary = 'Push a local file to the iOS simulator';
  static description =
    'Upload a local file into the simulator sandbox and return the remote path that can be used by follow-up commands such as `ios simctl`. ' +
    'With --bundle-id, the destination is a relative path inside that app container instead (intermediate directories are created as needed).';
  static examples = [
    '<%= config.bin %> ios push-file ./fixtures/test.txt test.txt',
    '<%= config.bin %> ios push-file ./photo.jpeg documents/photo.jpeg --bundle-id com.example.app --container-type data',
    '<%= config.bin %> ios push-file ./payloads/input.json input.json --json',
  ];

  static args = {
    path: Args.string({
      description: 'Local file path to upload to the simulator.',
      required: true,
    }),
    destination: Args.string({
      description:
        'Destination filename in the simulator sandbox, or a relative path inside the app container when --bundle-id is provided.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    'bundle-id': Flags.string({
      description: 'Bundle ID of the installed app whose container should receive the file.',
    }),
    'container-type': Flags.string({
      description:
        "Container to target when --bundle-id is provided: 'app', 'data', or a specific App Group identifier. Defaults to 'app'.",
      dependsOn: ['bundle-id'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosPushFile);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);

      const localPath = path.resolve(args.path);
      if (!fs.existsSync(localPath)) {
        this.error(`File not found: ${localPath}`);
      }

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const remotePath = await client.pushFile(
          localPath,
          args.destination,
          flags['bundle-id'] ?
            { bundleId: flags['bundle-id'], containerType: flags['container-type'] }
          : undefined,
        );
        if (flags.json) {
          this.outputJson({ remotePath });
        } else {
          this.output(remotePath);
        }
      } finally {
        disconnect();
      }
    });
  }
}
