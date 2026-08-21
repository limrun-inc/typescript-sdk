import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidPushFile extends BaseCommand {
  static summary = 'Push a local file to a running Android instance';
  static description =
    'Upload a local file to the Android instance without an ADB connection and print the remote path. ' +
    'With a destination argument this behaves like `adb push`: the write happens with the same permissions ' +
    'the ADB shell user has, so protected locations are rejected just as they would be for adb. ' +
    'Without a destination the instance stores the file under an internal name.';

  static examples = [
    '<%= config.bin %> android push-file ./video.mp4',
    '<%= config.bin %> android push-file ./video.mp4 /data/local/tmp/video.mp4',
    '<%= config.bin %> android push-file ./document.pdf /sdcard/Download/document.pdf --id <instance-ID>',
  ];

  static args = {
    path: Args.string({
      description: 'Local file path to upload to the instance.',
      required: true,
    }),
    destination: Args.string({
      description: 'Optional absolute destination path on the instance, like the adb push destination.',
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
    const { args, flags } = await this.parse(AndroidPushFile);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const localPath = path.resolve(args.path);
      if (!fs.existsSync(localPath)) {
        this.error(`File not found: ${localPath}`);
      }

      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        const remotePath = await client.pushFile(localPath, args.destination);
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
