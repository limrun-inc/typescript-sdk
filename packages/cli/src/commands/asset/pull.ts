import path from 'path';
import fs from 'fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AssetPull extends BaseCommand {
  static summary = 'Download an asset file';
  static description =
    'Download an asset by ID or by name into a local directory. For reliable automation, prefer an asset ID or ensure the name resolves to exactly one asset.';
  static examples = [
    '<%= config.bin %> asset pull <ID>',
    '<%= config.bin %> asset pull my-app.apk',
    '<%= config.bin %> asset list --name my-app.apk --json',
    '<%= config.bin %> asset pull <ID> -o ./downloads',
    '<%= config.bin %> asset pull my-app.apk --name my-app.apk',
  ];

  static args = {
    id_or_name: Args.string({ description: 'Asset ID or asset name to download', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({
      char: 'n',
      description: 'Explicit asset name to search for when the positional argument is not an asset ID',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output directory where the downloaded file should be written',
      default: '.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AssetPull);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      let asset: { name: string; signedDownloadUrl?: string };

      // If the argument contains underscore prefix pattern, treat as ID; otherwise as name
      const isId = args.id_or_name.includes('_');

      if (isId) {
        const fetched = await this.client.assets.get(args.id_or_name, { includeDownloadUrl: true });
        asset = fetched;
      } else {
        const searchName = flags.name || args.id_or_name;
        const fetched = await this.client.assets.list({
          nameFilter: searchName,
          includeDownloadUrl: true,
        });
        const list = fetched as any[];
        if (list.length === 0) {
          this.error(`Asset with name "${searchName}" not found`);
        }
        if (list.length > 1) {
          const matches = list
            .map((item) => item.metadata?.id || item.id || item.name || '<unknown>')
            .slice(0, 5)
            .join(', ');
          this.error(
            `Asset name "${searchName}" matched multiple assets (${matches}). Use an asset ID or narrow the name first with \`lim asset list --name "${searchName}" --json\`.`,
          );
        }
        asset = list[0];
      }

      if (!asset.signedDownloadUrl) {
        this.error('Asset does not have a download URL');
      }

      const outDir = path.resolve(flags.output);
      fs.mkdirSync(outDir, { recursive: true });
      const fullPath = path.join(outDir, asset.name);

      this.info(`Pulling to ${fullPath}`);

      const resp = await fetch(asset.signedDownloadUrl);
      if (!resp.ok) {
        const body = await resp.text();
        this.error(`Failed to download file: ${body}`);
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(fullPath, buffer);
      this.output(`Saved to ${fullPath}`);
    });
  }
}
