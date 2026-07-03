import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

type KeychainAsset = {
  id: string;
  name: string;
  signedDownloadUrl?: string;
};

export default class IosKeychainImport extends BaseCommand {
  static summary = 'Import iOS keychain state from asset storage';
  static description =
    'Resolve a Keychain asset by name or ID, then ask the target iOS simulator to download and apply the keychain tar.gz.';
  static examples = [
    '<%= config.bin %> ios keychain import keychain/state.tar.gz',
    '<%= config.bin %> ios keychain import keychain/state.tar.gz --id <instance-ID>',
    '<%= config.bin %> ios keychain import --url https://example.t3.storage.dev/... --json',
  ];

  static args = {
    asset_name: Args.string({ description: 'Keychain asset name or ID to import', required: false }),
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
    const { args, flags } = await this.parse(IosKeychainImport);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const url = flags.url ?? (await this.resolveKeychainAssetDownloadUrl(args.asset_name, flags.name));

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const result = await client.importKeychain({ url });
        if (flags.json) {
          this.outputJson(result);
        } else {
          this.output(`Keychain applied: ${result.keychainApplied ? 'yes' : 'no'}`);
          this.output(`Duration: ${result.durationMs}ms`);
        }
      } finally {
        disconnect();
      }
    });
  }

  private async resolveKeychainAssetDownloadUrl(
    idOrName: string | undefined,
    explicitName: string | undefined,
  ) {
    if (!idOrName && !explicitName) {
      this.error('Provide a keychain asset ID/name or --url.');
    }

    let asset: KeychainAsset;
    const value = idOrName ?? explicitName!;
    if (value.includes('_')) {
      asset = await this.client.assets.get(value, { includeDownloadUrl: true });
    } else {
      const searchName = explicitName || value;
      const matches = (await this.client.assets.list({
        nameFilter: searchName,
        kindFilter: 'Keychain',
        includeDownloadUrl: true,
      })) as KeychainAsset[];
      if (matches.length === 0) {
        this.error(`Keychain asset with name "${searchName}" not found`);
      }
      if (matches.length > 1) {
        const ids = matches
          .map((item) => item.id || item.name || '<unknown>')
          .slice(0, 5)
          .join(', ');
        this.error(`Keychain asset name "${searchName}" matched multiple assets (${ids}). Use an asset ID.`);
      }
      asset = matches[0]!;
    }

    if (!asset.signedDownloadUrl) {
      this.error('Keychain asset does not have a download URL');
    }
    return asset.signedDownloadUrl;
  }
}
