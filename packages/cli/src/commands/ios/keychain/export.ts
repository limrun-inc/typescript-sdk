import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import {
  DEFAULT_KEYCHAIN_ASSET_NAME,
  generateKeychainEncryptionKey,
  resolveKeychainEncryptionKey,
} from '../../../lib/keychain-encryption-key';

export default class IosKeychainExport extends BaseCommand {
  static summary = 'Export iOS keychain state to asset storage';
  static description =
    'Create or reuse a Keychain asset, ask the target iOS simulator to upload its keychain tar.gz to asset storage, and print the asset ID.';
  static examples = [
    '<%= config.bin %> ios keychain export',
    '<%= config.bin %> ios keychain export keychain/login.tar.gz',
    '<%= config.bin %> ios keychain export keychain/login.tar.gz --ttl 24h --json',
    '<%= config.bin %> ios keychain generate-key > keychain.key',
    '<%= config.bin %> ios keychain export keychain/login.tar.gz --encryption-key-stdin < keychain.key',
  ];

  static args = {
    asset_name: Args.string({
      description: `Keychain asset name to store the exported keychain under. Defaults to ${DEFAULT_KEYCHAIN_ASSET_NAME}.`,
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to export from. Defaults to the last created iOS instance.',
    }),
    'asset-name': Flags.string({
      description:
        `Asset name to store the exported keychain under. Defaults to ${DEFAULT_KEYCHAIN_ASSET_NAME}. Prefer the positional <asset-name> argument.`,
    }),
    ttl: Flags.string({
      description: 'Time-to-live as a Go duration (e.g. "24h", min 1m). Defaults to no expiry.',
    }),
    'encryption-key': Flags.string({
      description:
        'Base64/base64url 32-byte encryption key for the exported keychain archive. Generated and printed if omitted.',
    }),
    'encryption-key-stdin': Flags.boolean({
      description: 'Read the base64/base64url 32-byte encryption key from stdin.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosKeychainExport);
    this.setParsedFlags(flags);

    const assetName = args.asset_name ?? flags['asset-name'] ?? DEFAULT_KEYCHAIN_ASSET_NAME;
    let encryptionKey: string;
    let generatedEncryptionKey = false;
    try {
      if (flags['encryption-key'] !== undefined || flags['encryption-key-stdin']) {
        encryptionKey = await resolveKeychainEncryptionKey({
          encryptionKey: flags['encryption-key'],
          encryptionKeyStdin: flags['encryption-key-stdin'],
        });
      } else {
        encryptionKey = generateKeychainEncryptionKey();
        generatedEncryptionKey = true;
      }
    } catch (error) {
      this.error((error as Error).message);
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const asset = await this.client.assets.getOrCreate({
        name: assetName,
        kind: 'Keychain',
        platform: 'ios',
        ttl: flags.ttl,
      });

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.exportKeychain({ url: asset.signedUploadUrl, encryptionKey });
      } finally {
        disconnect();
      }

      if (flags.json) {
        this.outputJson(generatedEncryptionKey ? { ...asset, encryptionKey } : asset);
        return;
      }
      this.output(`ID: ${asset.id}`);
      this.output(`Name: ${asset.name}`);
      if (asset.expiresAt) {
        this.output(`Expires At: ${asset.expiresAt}`);
      }
      if (generatedEncryptionKey) {
        this.output(`Auto-generated the encryption key.`);
      }
      this.output(`You can import with the following command: \n\n$ lim ios keychain import ${asset.name} --encryption-key ${generatedEncryptionKey ? encryptionKey : '<key>'}`);
    });
  }
}
