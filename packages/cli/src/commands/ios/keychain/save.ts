import { Args, Flags } from '@oclif/core';
import prompts from 'prompts';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import {
  DEFAULT_KEYCHAIN_ASSET_NAME,
  generateKeychainEncryptionKey,
  resolveKeychainEncryptionKey,
} from '../../../lib/keychain-encryption-key';

type KeychainAsset = {
  id?: string;
  name?: string;
  kind?: string;
};

export default class IosKeychainSave extends BaseCommand {
  static summary = 'Save iOS keychain state to asset storage';
  static description =
    'Create a Keychain asset or confirm overwriting an existing one, ask the target iOS simulator to upload its keychain tar.gz to asset storage, and print the asset ID.';
  static examples = [
    '<%= config.bin %> ios keychain save',
    '<%= config.bin %> ios keychain save keychain/login.tar.gz',
    '<%= config.bin %> ios keychain save keychain/login.tar.gz --ttl 24h --json',
    '<%= config.bin %> ios keychain save keychain/login.tar.gz --yes',
    '<%= config.bin %> ios keychain generate-key > keychain.key',
    '<%= config.bin %> ios keychain save keychain/login.tar.gz --encryption-key-stdin < keychain.key',
  ];

  static args = {
    asset_name: Args.string({
      description: `Keychain asset name to store the saved keychain under. Defaults to ${DEFAULT_KEYCHAIN_ASSET_NAME}.`,
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to save from. Defaults to the last created iOS instance.',
    }),
    'asset-name': Flags.string({
      description: `Asset name to store the saved keychain under. Defaults to ${DEFAULT_KEYCHAIN_ASSET_NAME}. Prefer the positional <asset-name> argument.`,
    }),
    ttl: Flags.string({
      description: 'Time-to-live as a Go duration (e.g. "24h", min 1m). Defaults to no expiry.',
    }),
    'encryption-key': Flags.string({
      description:
        'Base64/base64url 32-byte encryption key for the saved keychain archive. Generated and printed if omitted.',
    }),
    'encryption-key-stdin': Flags.boolean({
      description: 'Read the base64/base64url 32-byte encryption key from stdin.',
      default: false,
    }),
    yes: Flags.boolean({
      description: 'Overwrite an existing keychain asset without prompting.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosKeychainSave);
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
      const existingAssets = await this.listExistingKeychainAssets(assetName);
      if (existingAssets.length > 0) {
        const shouldOverwrite = await this.confirmOverwrite(assetName, existingAssets, flags.yes);
        if (!shouldOverwrite) {
          this.info('Save cancelled.');
          return;
        }
      }

      const asset = await this.client.assets.getOrCreate({
        name: assetName,
        kind: 'Keychain',
        platform: 'ios',
        ttl: flags.ttl,
      });

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.saveKeychain({ url: asset.signedUploadUrl, encryptionKey });
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
      this.output(
        `You can restore with the following command: \n\n$ lim ios keychain restore ${
          asset.name
        } --encryption-key ${generatedEncryptionKey ? encryptionKey : '<key>'}`,
      );
    });
  }

  private async listExistingKeychainAssets(assetName: string): Promise<KeychainAsset[]> {
    return (await this.client.assets.list({
      nameFilter: assetName,
      kindFilter: 'Keychain',
    })) as KeychainAsset[];
  }

  private async confirmOverwrite(
    assetName: string,
    existingAssets: KeychainAsset[],
    yes: boolean,
  ): Promise<boolean> {
    if (yes) {
      return true;
    }
    if (!process.stdin.isTTY) {
      this.error(`Keychain asset "${assetName}" already exists. Re-run with --yes to overwrite it.`);
    }

    const assetLabel =
      existingAssets.length === 1 ? 'A keychain asset' : `${existingAssets.length} keychain assets`;
    const response = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: `${assetLabel} named "${assetName}" already exists. Overwrite?`,
      initial: false,
      stdout: process.stderr,
    });
    return Boolean(response.overwrite);
  }
}
