import fs from 'fs';
import path from 'path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosScreenshot extends BaseCommand {
  static summary = 'Capture a screenshot from a running iOS instance';
  static description =
    'Capture the current screen from a running iOS instance. Save the image to a file with `-o`, or use `--json` to inspect the raw response payload.';
  static examples = [
    '<%= config.bin %> ios screenshot -o screenshot.png',
    '<%= config.bin %> ios screenshot --id <instance-ID>',
    '<%= config.bin %> ios screenshot --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to capture. Defaults to the last created iOS instance.',
    }),
    output: Flags.string({
      char: 'o',
      description: 'File path where the screenshot should be written instead of printing the raw image data',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosScreenshot);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios screenshot only supports iOS instances');
      }

      let screenshot: any;
      if (hasActiveSession(id)) {
        screenshot = await sendSessionCommand(id, 'screenshot');
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'ios') {
            this.error('ios screenshot only supports iOS instances');
          }
          screenshot = await client.screenshot();
        } finally {
          disconnect();
        }
      }

      if (flags.output) {
        const outPath = path.resolve(flags.output);
        fs.writeFileSync(outPath, Buffer.from(screenshot.base64, 'base64'));
        this.log(`Screenshot saved to ${outPath}`);
      } else if (flags.json) {
        this.outputJson(screenshot);
      } else {
        this.log(screenshot.base64);
      }
    });
  }
}
