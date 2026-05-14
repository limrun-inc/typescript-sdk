import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getAndroidInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidScreenshot extends BaseCommand {
  static summary = 'Capture a screenshot from a running Android instance';
  static description =
    'Capture the current screen from a running Android instance and save the image to a file.';
  static examples = [
    '<%= config.bin %> android screenshot screenshot.png',
    '<%= config.bin %> android screenshot screenshot.png --id <instance-ID>',
    '<%= config.bin %> android screenshot screenshot.png --json',
  ];

  static args = {
    path: Args.string({
      description: 'File path where the screenshot should be written.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to capture. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidScreenshot);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('android screenshot only supports Android instances');
      }

      let screenshot: any;
      if (hasActiveSession(id)) {
        screenshot = await sendSessionCommand(id, 'screenshot');
      } else {
        const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
        try {
          screenshot = await client.screenshot();
        } finally {
          disconnect();
        }
      }

      const outPath = path.resolve(args.path);
      const base64 = (screenshot.dataUri as string).replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      if (flags.json) {
        this.outputJson({ path: outPath });
      } else {
        this.log(`Screenshot saved to ${outPath}`);
      }
    });
  }
}
