import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { savedGoogleAccessToken } from '../../../lib/google-auth';
import { savePrivateFile } from '../../../lib/store-output';

export default class RefreshPlayAuth extends BaseCommand {
  static summary = 'Refresh the saved Play login and write its access token to a private file';
  static description =
    'Builds and Play actions refresh automatically. Use this command when another local tool needs a short-lived access token. The refresh token remains in ~/.lim/secrets.';
  static flags = {
    ...BaseCommand.baseFlags,
    output: Flags.string({ description: 'Destination token file. Must not exist.', required: true }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(RefreshPlayAuth);
    this.setParsedFlags(flags);
    this.outputJson(
      await savePrivateFile(flags.output, async () => {
        const token = await savedGoogleAccessToken();
        if (!token) throw new Error('Run lim android play auth first.');
        return token + '\n';
      }),
    );
  }
}
