import { Command } from '@oclif/core';
import { readConfig } from '../lib/config';
import { login } from '../lib/auth';

const VERSION = require('../../package.json').version;

export default class Login extends Command {
  static summary = 'Log in to Limrun';
  static description = 'Opens your browser to authenticate with Limrun and stores the API key locally.';

  async run(): Promise<void> {
    const config = readConfig();
    this.log('Opening browser to log in...');
    await login(config.consoleEndpoint, VERSION);
    this.log('You are logged in now.');
  }
}
