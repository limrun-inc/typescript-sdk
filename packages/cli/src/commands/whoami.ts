import { BaseCommand } from '../base-command';
import { readConfig } from '../lib/config';
import { isPendingLoginExpired, pendingLoginInfo, readPendingLogin } from '../lib/auth';
import { identity } from '../lib/backend';

export default class Whoami extends BaseCommand {
  static summary = 'Show whether you are logged in';
  static description =
    'Check the stored or passed API key against Limrun and print the organization it acts for. The key itself is never printed. When you are not logged in, a pending `lim login` is shown with its URL and phrase. Exits 0 in both cases; read `signedIn`.';
  static examples = ['<%= config.bin %> whoami', '<%= config.bin %> whoami --json'];
  static flags = BaseCommand.readOnlyFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(Whoami);
    this.setParsedFlags(flags);
    const hasKey = Boolean(flags['api-key'] || readConfig().apiKey);
    const who = hasKey ? await identity(this.client) : null;
    if (who) {
      const org = who.organizationName ?? who.organizationId ?? 'unknown organization';
      this.outputResult(
        { signedIn: true, ...who },
        `Logged in to ${org}${who.email ? ` as ${who.email}` : ''}.`,
      );
      return;
    }
    const pending = readPendingLogin();
    const pendingLogin = pending && !isPendingLoginExpired(pending) ? pendingLoginInfo(pending) : undefined;
    this.outputResult(
      { signedIn: false, ...(pendingLogin ? { pendingLogin } : {}) },
      pendingLogin ?
        `Not logged in. A login is pending: open ${pendingLogin.verificationUrl} and confirm "${pendingLogin.phrase}". Run \`lim login\` to continue it.`
      : 'Not logged in. Run `lim login`.',
    );
  }
}
