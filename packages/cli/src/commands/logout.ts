import { Command } from '@oclif/core';
import { clearApiKey } from '../lib/config';

export default class Logout extends Command {
  static summary = 'Log out of Limrun';
  static description = 'Remove the stored API key so future CLI commands must authenticate again.';
  static examples = ['<%= config.bin %> logout'];

  async run(): Promise<void> {
    clearApiKey();
    this.log('Logged out.');
  }
}
