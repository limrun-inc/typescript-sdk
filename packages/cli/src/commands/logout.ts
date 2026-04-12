import { Command } from '@oclif/core';
import { clearApiKey } from '../lib/config';

export default class Logout extends Command {
  static summary = 'Log out of Limrun';
  static description = 'Removes the stored API key.';

  async run(): Promise<void> {
    clearApiKey();
    this.log('Logged out.');
  }
}
