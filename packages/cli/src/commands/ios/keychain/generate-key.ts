import { BaseCommand } from '../../../base-command';
import { generateKeychainEncryptionKey } from '../../../lib/keychain-encryption-key';

export default class IosKeychainGenerateKey extends BaseCommand {
  static summary = 'Generate an iOS keychain encryption key';
  static description =
    'Print a new 32-byte base64 key for encrypted iOS keychain save and restore. Store it securely and pass it to save/restore on stdin.';
  static examples = ['<%= config.bin %> ios keychain generate-key > keychain.key'];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosKeychainGenerateKey);
    this.setParsedFlags(flags);
    this.output(generateKeychainEncryptionKey());
  }
}
