import path from 'path';
import fs from 'fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { ByteProgressBar } from '../../lib/byte-progress';

export default class AssetPush extends BaseCommand {
  static summary = 'Upload an asset file';
  static description =
    'Upload a local file to Limrun asset storage so it can be installed on instances or reused by later commands. The asset name defaults to the filename unless you provide `-n`.';
  static aliases = ['assets:push'];
  static examples = [
    '<%= config.bin %> asset push ./app.apk',
    '<%= config.bin %> asset push ./app.ipa -n my-app',
    '<%= config.bin %> asset push ./app.ipa --ttl 24h',
  ];

  static args = {
    file: Args.string({ description: 'Path to the local file to upload as an asset', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ char: 'n', description: 'Asset name to store. Defaults to the source filename.' }),
    ttl: Flags.string({
      description: 'Time-to-live as a Go duration (e.g. "24h", min 1m). Defaults to no expiry.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AssetPush);
    this.setParsedFlags(flags);

    const filePath = path.resolve(args.file);
    if (!fs.existsSync(filePath)) {
      this.error(`File not found: ${filePath}`);
    }

    const assetName = flags.name || path.basename(filePath);
    await this.withAuth(async () => {
      // Only opt into the streaming upload path when progress would actually be
      // reported (bar on a TTY, milestone lines otherwise); --json/--quiet keeps
      // the plain buffered upload.
      const showProgress = !this.shouldSuppressInfo();
      const bar = new ByteProgressBar('Pushing', !showProgress);
      let asset;
      try {
        asset = await this.client.assets.getOrUpload({
          path: filePath,
          name: assetName,
          ttl: flags.ttl,
          ...(showProgress && {
            onUploadProgress: (uploadedBytes: number, totalBytes: number) =>
              bar.update(uploadedBytes, totalBytes),
          }),
        });
      } finally {
        bar.stop();
      }

      this.output(`ID: ${asset.id}`);
      if (asset.expiresAt) {
        this.output(`Expires At: ${asset.expiresAt}`);
      }
    });
  }
}
