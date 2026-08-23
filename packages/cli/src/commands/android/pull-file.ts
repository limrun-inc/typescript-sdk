import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidPullFile extends BaseCommand {
  static summary = 'Pull a file from a running Android instance';
  static description =
    'Download a file from the Android instance without an ADB connection and save it locally. ' +
    'This behaves like `adb pull`: the read happens with the same permissions the ADB shell user has, ' +
    'so protected locations are rejected just as they would be for adb.';

  static examples = [
    '<%= config.bin %> android pull-file /sdcard/Download/photo.jpeg',
    '<%= config.bin %> android pull-file /data/local/tmp/log.txt ./device-log.txt',
    '<%= config.bin %> android pull-file /sdcard/Download/photo.jpeg ./photo.jpeg --id <instance-ID>',
  ];

  static args = {
    path: Args.string({
      description: 'Absolute path of the file on the instance, like the adb pull source.',
      required: true,
    }),
    destination: Args.string({
      description:
        'Local path to save the file to. Defaults to the remote filename in the current directory.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidPullFile);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const localPath = path.resolve(args.destination ?? path.posix.basename(args.path));

      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        // Streamed to disk by the SDK, so large files never sit in memory.
        await client.pullFile(args.path, localPath);
        if (flags.json) {
          this.outputJson({ localPath, bytes: fs.statSync(localPath).size });
        } else {
          this.output(localPath);
        }
      } finally {
        disconnect();
      }
    });
  }
}
