import path from 'path';
import fs from 'fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AssetPush extends BaseCommand {
  static summary = 'Upload an asset file';
  static aliases = ['push'];
  static examples = [
    '<%= config.bin %> asset push ./app.apk',
    '<%= config.bin %> asset push ./app.ipa -n my-app',
  ];

  static args = {
    file: Args.string({ description: 'Path to the file to upload', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ char: 'n', description: 'Name for the asset (defaults to filename)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AssetPush);
    this.setParsedFlags(flags);

    const filePath = path.resolve(args.file);
    if (!fs.existsSync(filePath)) {
      this.error(`File not found: ${filePath}`);
    }

    const assetName = flags.name || path.basename(filePath);
    this.log(`Name: ${assetName}`);

    await this.withAuth(async () => {
      const asset = await this.client.assets.getOrUpload({
        path: filePath,
        name: assetName,
      });

      this.log(`ID: ${asset.id}`);
      this.log('\nDone!');
    });
  }
}
