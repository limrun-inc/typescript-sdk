import path from 'path';
import fs from 'fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AssetPush extends BaseCommand {
  static summary = 'Upload an asset file';
  static description =
    'Upload a local file to Limrun asset storage so it can be installed on instances or reused by later commands. The asset name defaults to the filename unless you provide `-n`.';
  static examples = [
    '<%= config.bin %> asset push ./app.apk',
    '<%= config.bin %> asset push ./app.ipa -n my-app',
  ];

  static args = {
    file: Args.string({ description: 'Path to the local file to upload as an asset', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ char: 'n', description: 'Asset name to store. Defaults to the source filename.' }),
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
