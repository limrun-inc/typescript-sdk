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

export default class AndroidScreenshot extends BaseCommand {
  static summary = 'Capture a screenshot from a running Android instance';
  static description =
    'Capture the current screen from a running Android instance. Save the image to a file with `-o`, or use `--json` to inspect the raw response payload.';
  static examples = [
    '<%= config.bin %> android screenshot -o screenshot.png',
    '<%= config.bin %> android screenshot --id <instance-ID>',
    '<%= config.bin %> android screenshot --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to capture. Defaults to the last created Android instance.',
    }),
    output: Flags.string({
      char: 'o',
      description: 'File path where the screenshot should be written instead of printing the raw image data',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidScreenshot);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android screenshot only supports Android instances');
      }

      let screenshot: any;
      if (hasActiveSession(id)) {
        screenshot = await sendSessionCommand(id, 'screenshot');
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'android') {
            this.error('android screenshot only supports Android instances');
          }
          screenshot = await client.screenshot();
        } finally {
          disconnect();
        }
      }

      if (flags.output) {
        const outPath = path.resolve(flags.output);
        const base64 = (screenshot.dataUri as string).replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
        this.log(`Screenshot saved to ${outPath}`);
      } else if (flags.json) {
        this.outputJson(screenshot);
      } else {
        this.log(screenshot.dataUri);
      }
    });
  }
}
