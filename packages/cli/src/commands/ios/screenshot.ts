import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import type { ScreenshotOptions } from '@limrun/api/ios-client';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosScreenshot extends BaseCommand {
  static summary = 'Capture a screenshot from a running iOS instance';
  static description = 'Capture the current screen from a running iOS instance and save the image to a file.';
  static examples = [
    '<%= config.bin %> ios screenshot screenshot.png',
    '<%= config.bin %> ios screenshot screenshot.png --id <instance-ID>',
    '<%= config.bin %> ios screenshot screenshot.png --json',
    '<%= config.bin %> ios screenshot app-store.png --format png --size full',
  ];

  static args = {
    path: Args.string({
      description: 'File path where the screenshot should be written.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    format: Flags.string({
      options: ['jpeg', 'png'],
      default: 'jpeg',
      description: 'Screenshot image format. PNG images have no alpha channel.',
    }),
    size: Flags.string({
      options: ['scaled', 'full'],
      default: 'scaled',
      description: 'scaled uses tap-point dimensions; full preserves native pixel resolution.',
    }),
    display: Flags.string({
      options: ['outer', 'inner'],
      description: 'Capture a specific iPhone Duo display.',
    }),
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

      const options: ScreenshotOptions = {
        format: flags.format as ScreenshotOptions['format'],
        size: flags.size as ScreenshotOptions['size'],
      };
      let screenshot: any;
      if (!flags.display && (await ensureDaemonSession(resolvedInstance))) {
        screenshot = await sendSessionCommand(id, 'screenshot', [options]);
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          screenshot =
            flags.display ?
              await client.screenshotDisplay(flags.display as 'outer' | 'inner', options)
            : await client.screenshot(options);
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
