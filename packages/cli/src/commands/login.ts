import { BaseCommand } from '../base-command';
import { readConfig } from '../lib/config';
import { login } from '../lib/auth';

const VERSION = require('../../package.json').version;
const loginFlags = { ...BaseCommand.baseFlags };
delete (loginFlags as Partial<typeof loginFlags>).json;

export default class Login extends BaseCommand {
  static summary = 'Log in to Limrun';
  static description =
    'Open your browser to authenticate with Limrun and store the resulting API key locally for future CLI commands.';
  static examples = ['<%= config.bin %> login'];
  static flags = loginFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);
    this.setParsedFlags(flags);
    const config = readConfig();
    this.info('Opening browser to log in...');
    await login(config.apiEndpoint, config.consoleEndpoint, VERSION, {
      log: (message) => this.info(message),
      promptBeforeOpen: !this.shouldSuppressInfo(),
    });
    this.info('You are logged in now.');
  }
}
