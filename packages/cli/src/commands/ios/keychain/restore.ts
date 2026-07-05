import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import {
  DEFAULT_KEYCHAIN_ASSET_NAME,
  resolveKeychainEncryptionKey,
} from '../../../lib/keychain-encryption-key';

type KeychainAsset = {
  id: string;
  name: string;
  kind?: string;
  signedDownloadUrl?: string;
};

export default class IosKeychainRestore extends BaseCommand {
  static summary = 'Restore iOS keychain state from asset storage';
  static description =
    'Resolve a Keychain asset by name, then ask the target iOS simulator to download and apply the keychain tar.gz. Use --asset-id to restore by asset ID.';
  static examples = [
    '<%= config.bin %> ios keychain restore keychain/login.tar.gz',
    '<%= config.bin %> ios keychain restore keychain/login.tar.gz --id <instance-ID>',
    '<%= config.bin %> ios keychain restore --asset-id <asset-ID>',
    '<%= config.bin %> ios keychain restore --url https://example.t3.storage.dev/... --json',
    '<%= config.bin %> ios keychain restore keychain/login.tar.gz --encryption-key-stdin < keychain.key',
  ];

  static args = {
    asset_name: Args.string({
      description: `Keychain asset name to restore. Defaults to ${DEFAULT_KEYCHAIN_ASSET_NAME}.`,
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to restore into. Defaults to the last created iOS instance.',
    }),
    url: Flags.string({
      description: 'Presigned download URL to restore directly instead of resolving an asset.',
    }),
    'asset-id': Flags.string({
      description: 'Keychain asset ID to restore instead of resolving the positional asset name.',
    }),
    'encryption-key': Flags.string({
      description: 'Base64/base64url 32-byte decryption key for the keychain archive.',
    }),
    'encryption-key-stdin': Flags.boolean({
      description: 'Read the base64/base64url 32-byte decryption key from stdin.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosKeychainRestore);
    this.setParsedFlags(flags);

    let encryptionKey: string;
    try {
      encryptionKey = await resolveKeychainEncryptionKey({
        encryptionKey: flags['encryption-key'],
        encryptionKeyStdin: flags['encryption-key-stdin'],
      });
    } catch (error) {
      this.error((error as Error).message);
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const assetName =
        args.asset_name ?? (!flags.url && !flags['asset-id'] ? DEFAULT_KEYCHAIN_ASSET_NAME : undefined);
      const url =
        flags.url ?? (await this.resolveKeychainAssetDownloadUrl(assetName, flags['asset-id']));
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const result = await client.restoreKeychain({ url, encryptionKey });
        if (flags.json) {
          this.outputJson(result);
          return;
        }
        this.output('Keychain restored');
        this.output(`Duration: ${result.durationMs}ms`);
      } finally {
        disconnect();
      }
    });
  }

  private async resolveKeychainAssetDownloadUrl(assetName: string | undefined, assetID: string | undefined) {
    if (assetName && assetID) {
      this.error('Use either a keychain asset name or --asset-id, not both.');
    }
    if (!assetName && !assetID) {
      this.error('Provide a keychain asset name, --asset-id, or --url.');
    }

    let asset: KeychainAsset;
    if (assetID) {
      asset = await this.client.assets.get(assetID, { includeDownloadUrl: true });
    } else {
      const matches = (await this.client.assets.list({
        nameFilter: assetName!,
        kindFilter: 'Keychain',
        includeDownloadUrl: true,
      })) as KeychainAsset[];
      if (matches.length === 0) {
        this.error(`Keychain asset with name "${assetName}" not found`);
      }
      if (matches.length > 1) {
        const ids = matches
          .map((item) => item.id || item.name || '<unknown>')
          .slice(0, 5)
          .join(', ');
        this.error(`Keychain asset name "${assetName}" matched multiple assets (${ids}). Use --asset-id.`);
      }
      asset = matches[0]!;
    }

    if (asset.kind !== 'Keychain') {
      this.error(`Asset "${asset.id || asset.name}" is ${asset.kind || 'unknown'} kind, expected Keychain.`);
    }
    if (!asset.signedDownloadUrl) {
      this.error('Keychain asset does not have a download URL');
    }
    return asset.signedDownloadUrl;
  }
}
