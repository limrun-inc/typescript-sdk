import path from 'path';
import fs from 'fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';

export default class Pull extends BaseCommand {
  static summary = 'Download an asset file';
  static examples = [
    '<%= config.bin %> pull <ID>',
    '<%= config.bin %> pull my-app.apk',
    '<%= config.bin %> pull <ID> -o ./downloads',
  ];

  static args = {
    id_or_name: Args.string({ description: 'Asset ID or name', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ char: 'n', description: 'Asset name to search for' }),
    output: Flags.string({ char: 'o', description: 'Output directory (defaults to current directory)', default: '.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Pull);
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
        asset = list[0];
      }

      if (!asset.signedDownloadUrl) {
        this.error('Asset does not have a download URL');
      }

      const outDir = path.resolve(flags.output);
      fs.mkdirSync(outDir, { recursive: true });
      const fullPath = path.join(outDir, asset.name);

      this.log(`Pulling to ${fullPath}`);

      const resp = await fetch(asset.signedDownloadUrl);
      if (!resp.ok) {
        const body = await resp.text();
        this.error(`Failed to download file: ${body}`);
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(fullPath, buffer);
      this.log('Done!');
    });
  }
}
