import fs from 'fs';
import path from 'path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecScreenshot extends BaseCommand {
  static summary = 'Capture a screenshot from a running instance';
  static description =
    'Capture the current screen from a running iOS or Android instance. Save the image to a file with `-o`, or use `--json` to inspect the raw response payload.';
  static aliases = ['ios screenshot', 'android screenshot', 'screenshot'];
  static examples = [
    '<%= config.bin %> ios screenshot -o screenshot.png',
    '<%= config.bin %> android screenshot --id <instance-ID>',
    '<%= config.bin %> ios screenshot --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Instance ID to capture. Defaults to the last created instance of the command alias type.',
    }),
    output: Flags.string({
      char: 'o',
      description: 'File path where the screenshot should be written instead of printing the raw image data',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ExecScreenshot);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      let screenshot: any;
      let type: string;

      if (hasActiveSession(id)) {
        screenshot = await sendSessionCommand(id, 'screenshot');
        type = id.split('_')[0];
      } else {
        const resolved = await getInstanceClient(this.client, id);
        type = resolved.type;
        try {
          screenshot = await resolved.client.screenshot();
        } finally {
          resolved.disconnect();
        }
      }

      if (flags.output) {
        const outPath = path.resolve(flags.output);
        if (type === 'ios') {
          fs.writeFileSync(outPath, Buffer.from(screenshot.base64, 'base64'));
        } else {
          const base64 = (screenshot.dataUri as string).replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
        }
        this.log(`Screenshot saved to ${outPath}`);
      } else if (flags.json) {
        this.outputJson(screenshot);
      } else {
        this.log(type === 'ios' ? screenshot.base64 : screenshot.dataUri);
      }
    });
  }
}
