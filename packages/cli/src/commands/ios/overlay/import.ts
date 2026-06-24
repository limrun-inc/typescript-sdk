import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

type OverlayAsset = {
  id: string;
  name: string;
  signedDownloadUrl?: string;
};

export default class IosOverlayImport extends BaseCommand {
  static summary = 'Import an iOS account overlay from asset storage';
  static description =
    'Resolve an Overlay asset by ID or name, then ask the target iOS simulator to download and apply the overlay tar.gz.';
  static examples = [
    '<%= config.bin %> ios overlay import <asset-ID>',
    '<%= config.bin %> ios overlay import accounts/overlay.tar.gz --id <instance-ID>',
    '<%= config.bin %> ios overlay import --url https://example.t3.storage.dev/... --json',
  ];

  static args = {
    id_or_name: Args.string({ description: 'Overlay asset ID or name to import', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to import into. Defaults to the last created iOS instance.',
    }),
    url: Flags.string({
      description: 'Presigned download URL to import directly instead of resolving an asset.',
    }),
    name: Flags.string({
      char: 'n',
      description: 'Explicit asset name to search for when the positional argument is not an asset ID.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosOverlayImport);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const url = flags.url ?? (await this.resolveOverlayAssetDownloadUrl(args.id_or_name, flags.name));

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const result = await client.importOverlay({ url });
        if (flags.json) {
          this.outputJson(result);
        } else {
          this.output(`Applied files: ${result.filesApplied.join(', ')}`);
          this.output(`Duration: ${result.durationMs}ms`);
        }
      } finally {
        disconnect();
      }
    });
  }

  private async resolveOverlayAssetDownloadUrl(idOrName: string | undefined, explicitName: string | undefined) {
    if (!idOrName && !explicitName) {
      this.error('Provide an overlay asset ID/name or --url.');
    }

    let asset: OverlayAsset;
    const value = idOrName ?? explicitName!;
    if (value.includes('_')) {
      asset = await this.client.assets.get(value, { includeDownloadUrl: true });
    } else {
      const searchName = explicitName || value;
      const matches = (await this.client.assets.list({
        nameFilter: searchName,
        kindFilter: 'Overlay',
        includeDownloadUrl: true,
      })) as OverlayAsset[];
      if (matches.length === 0) {
        this.error(`Overlay asset with name "${searchName}" not found`);
      }
      if (matches.length > 1) {
        const ids = matches
          .map((item) => item.id || item.name || '<unknown>')
          .slice(0, 5)
          .join(', ');
        this.error(`Overlay asset name "${searchName}" matched multiple assets (${ids}). Use an asset ID.`);
      }
      asset = matches[0]!;
    }

    if (!asset.signedDownloadUrl) {
      this.error('Overlay asset does not have a download URL');
    }
    return asset.signedDownloadUrl;
  }
}
