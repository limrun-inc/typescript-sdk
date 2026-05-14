import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosScreenshot extends BaseCommand {
  static summary = 'Capture a screenshot from a running iOS instance';
  static description =
    'Capture the current screen from a running iOS instance and save the image to a file.';
  static examples = [
    '<%= config.bin %> ios screenshot screenshot.png',
    '<%= config.bin %> ios screenshot screenshot.png --id <instance-ID>',
    '<%= config.bin %> ios screenshot screenshot.png --json',
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
      description: 'iOS instance ID to capture. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosScreenshot);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('ios screenshot only supports iOS instances');
      }

      let screenshot: any;
      if (hasActiveSession(id)) {
        screenshot = await sendSessionCommand(id, 'screenshot');
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          screenshot = await client.screenshot();
        } finally {
          disconnect();
        }
      }

      const outPath = path.resolve(args.path);
      fs.writeFileSync(outPath, Buffer.from(screenshot.base64, 'base64'));
      if (flags.json) {
        this.outputJson({ path: outPath });
      } else {
        this.log(`Screenshot saved to ${outPath}`);
      }
    });
  }
}
