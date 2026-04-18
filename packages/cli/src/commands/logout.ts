import { BaseCommand } from '../base-command';
import { clearApiKey } from '../lib/config';

export default class Logout extends BaseCommand {
  static summary = 'Log out of Limrun';
  static description = 'Remove the stored API key so future CLI commands must authenticate again.';
  static examples = ['<%= config.bin %> logout'];
  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(Logout);
    this.setParsedFlags(flags);
    clearApiKey();
    this.log('Logged out.');
  }
}
