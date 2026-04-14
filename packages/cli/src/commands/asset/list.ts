import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AssetList extends BaseCommand {
  static summary = 'List assets or get a specific one';
  static aliases = ['get asset', 'get assets'];
  static examples = ['<%= config.bin %> asset list', '<%= config.bin %> asset list <ID>'];

  static args = {
    id: Args.string({ description: 'Asset ID to get', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({ description: 'Filter by asset name' }),
    'download-url': Flags.boolean({ description: 'Include download URL in output', default: false }),
    'upload-url': Flags.boolean({ description: 'Include upload URL in output', default: false }),
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
