import { Args, Flags } from '@oclif/core';
import fs from 'fs';
import { BaseCommand } from '../../base-command';

export default class MacosScreenshot extends BaseCommand {
  static summary = 'Save a screenshot of a macOS instance';
  static description =
    'Save the screen of a macOS instance as a JPEG. Its pixels are the coordinates tap, scroll and drag take.';
  static examples = ['<%= config.bin %> macos screenshot screen.jpg'];

  static args = {
    path: Args.string({ description: 'File path to write the JPEG to.', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosScreenshot);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const { client } = await this.resolveMacosClient(flags.id);
      const image = await client.screenshot();
      fs.writeFileSync(args.path, image);
      this.outputResult({ path: args.path, bytes: image.length }, `Saved screenshot to ${args.path}`);
    });
  }
}
