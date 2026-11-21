import { BaseCommand } from '../base-command';
import { readConfig } from '../lib/config';
import { login } from '../lib/auth';

const VERSION = require('../../package.json').version;

export default class Login extends BaseCommand {
  static summary = 'Log in to Limrun';
  static description =
    'Open your browser to authenticate with Limrun and store the resulting API key locally for future CLI commands. Prints the verification URL and phrase first, then waits until you confirm on any device or the login expires. If the command is stopped, run it again to continue the same login with the same phrase. With --json, the URL and phrase are the first JSON line and the result is the last.';
  static examples = ['<%= config.bin %> login', '<%= config.bin %> login --json'];
  static flags = BaseCommand.baseFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);
    this.setParsedFlags(flags);
    const config = readConfig();
    this.info('Authenticating with Limrun...');
    await login(config.apiEndpoint, config.consoleEndpoint, VERSION, {
      log: (message) => this.info(message),
      ...(this.isJsonEnabled() ?
        { onPending: (pending) => this.outputEvent({ status: 'pending', ...pending }) }
      : {}),
    });
    if (this.isJsonEnabled()) {
      this.outputEvent({ status: 'signed-in' });
    } else {
      this.info('Authentication successful.');
    }
  }
}
