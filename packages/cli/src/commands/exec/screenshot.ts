import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecScreenshot extends BaseCommand {
  static summary = 'Capture a screenshot from a running instance';
  static aliases = ['ios screenshot', 'android screenshot', 'screenshot'];
  static examples = [
    '<%= config.bin %> ios screenshot <instance-ID> -o screenshot.png',
    '<%= config.bin %> android screenshot <instance-ID>',
  ];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    output: Flags.string({ char: 'o', description: 'Save screenshot to file path' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecScreenshot);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      let screenshot: any;
      let type: string;

      if (hasActiveSession(args.id)) {
        screenshot = await sendSessionCommand(args.id, 'screenshot');
        type = args.id.split('_')[0];
      } else {
        const resolved = await getInstanceClient(this.client, args.id);
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
