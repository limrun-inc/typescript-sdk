import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosOverlayExport extends BaseCommand {
  static summary = 'Export an iOS account overlay to asset storage';
  static description =
    'Create or reuse an Overlay asset, ask the target iOS simulator to upload its account overlay tar.gz to asset storage, and print the asset ID.';
  static examples = [
    '<%= config.bin %> ios overlay export --asset-name accounts/overlay.tar.gz',
    '<%= config.bin %> ios overlay export --asset-name accounts/overlay.tar.gz --ttl 24h --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to export from. Defaults to the last created iOS instance.',
    }),
    'asset-name': Flags.string({
      description: 'Asset name to store the exported overlay under.',
      required: true,
    }),
    ttl: Flags.string({
      description: 'Time-to-live as a Go duration (e.g. "24h", min 1m). Defaults to no expiry.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosOverlayExport);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const asset = await this.client.assets.getOrCreate({
        name: flags['asset-name'],
        kind: 'Overlay',
        platform: 'ios',
        ttl: flags.ttl,
      });

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.exportOverlay({ url: asset.signedUploadUrl });
      } finally {
        disconnect();
      }

      if (flags.json) {
        this.outputJson(asset);
        return;
      }
      this.output(`ID: ${asset.id}`);
      this.output(`Name: ${asset.name}`);
      if (asset.expiresAt) {
        this.output(`Expires At: ${asset.expiresAt}`);
      }
    });
  }
}
