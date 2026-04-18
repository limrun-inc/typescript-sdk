import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AssetList extends BaseCommand {
  static summary = 'List assets or get a specific one';
  static description =
    'List uploaded assets in your account or fetch a single asset by ID. You can optionally include signed download or upload URLs when preparing follow-up automation steps.';
  static examples = [
    '<%= config.bin %> asset list',
    '<%= config.bin %> asset list <ID>',
    '<%= config.bin %> asset list --name MyApp --download-url',
  ];

  static args = {
    id: Args.string({ description: 'Asset ID to fetch. Omit to list assets instead.', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ description: 'Filter listed assets by exact name' }),
    'download-url': Flags.boolean({
      description: 'Include a signed download URL in the output where available',
      default: false,
    }),
    'upload-url': Flags.boolean({
      description: 'Include a signed upload URL in the output where available',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AssetList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (args.id) {
        const asset = await this.client.assets.get(args.id, {
          includeDownloadUrl: flags['download-url'],
          includeUploadUrl: flags['upload-url'],
        });
        if (flags.json) {
          this.outputJson(asset);
          return;
        }
        const headers = ['ID', 'Name', 'MD5'];
        const row = [asset.id, asset.name, asset.md5 || ''];
        if (flags['download-url']) {
          headers.push('Download URL');
          row.push(asset.signedDownloadUrl || '');
        }
        if (flags['upload-url']) {
          headers.push('Upload URL');
          row.push(asset.signedUploadUrl || '');
        }
        this.outputTable(headers, [row]);
        return;
      }

      const params: Record<string, unknown> = {
        includeDownloadUrl: flags['download-url'],
        includeUploadUrl: flags['upload-url'],
      };
      if (flags.name) params.nameFilter = flags.name;

      const assets = await this.client.assets.list(params as any);
      const headers = ['ID', 'Name', 'MD5'];
      if (flags['download-url']) headers.push('Download URL');
      if (flags['upload-url']) headers.push('Upload URL');

      const rows = (assets as any[]).map((a: any) => {
        const row = [a.id, a.name, a.md5 || ''];
        if (flags['download-url']) row.push(a.signedDownloadUrl || '');
        if (flags['upload-url']) row.push(a.signedUploadUrl || '');
        return row;
      });

      if (flags.json) {
        this.outputJson(assets);
      } else {
        this.outputTable(headers, rows);
      }
    });
  }
}
