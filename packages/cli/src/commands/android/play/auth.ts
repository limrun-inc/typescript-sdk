import { PLAY_CONSOLE_SCOPE, PLAY_DEVELOPER_APP_SCOPE } from '@limrun/play-auth';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { authenticateGoogle, readGoogleDesktopClient } from '../../../lib/google-auth';
import { LocalSecretStore } from '../../../lib/local-secret-store';

export default class PlayAuth extends BaseCommand {
  static summary = 'Sign in to Google Play and save a refresh token on this computer';
  static description =
    'Open your browser using a Google Desktop OAuth client JSON file. Stores credentials in ~/.lim/secrets ' +
    'for future gradle builds with --upload-to-playstore. Run on the same computer as your browser. ' +
    'Your Google account must have access to the app in Play Console.';
  static examples = ['<%= config.bin %> android play auth --client-config client_secret.json'];
  static flags = {
    ...BaseCommand.baseFlags,
    'console-scope': Flags.string({
      description:
        'Additional scope for experimental signing enrollment. Requires Google approval for your OAuth client.',
      options: [PLAY_CONSOLE_SCOPE, PLAY_DEVELOPER_APP_SCOPE],
    }),
    'client-config': Flags.string({
      description: 'Downloaded Google OAuth client JSON for application type Desktop app.',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PlayAuth);
    this.setParsedFlags(flags);
    const client = await readGoogleDesktopClient(flags['client-config']);
    const store = new LocalSecretStore();
    await authenticateGoogle(
      client,
      async (url) => {
        // Authentication needs this URL even when quiet or JSON output is requested.
        process.stderr.write(`Open this URL in your browser to sign in to Google:\n${url}\n`);
        const importEsm = new Function('specifier', 'return import(specifier)') as (
          specifier: string,
        ) => Promise<typeof import('open')>;
        try {
          const { default: open } = await importEsm('open');
          await open(url);
        } catch {
          // The printed URL lets the user continue if no browser opener is available.
        }
      },
      store,
      fetch,
      flags['console-scope'] as typeof PLAY_CONSOLE_SCOPE | typeof PLAY_DEVELOPER_APP_SCOPE | undefined,
    );
    if (flags.json) this.outputJson({ directory: store.directory });
    else this.info(`Saved Google Play credentials in ${store.directory}.`);
  }
}
