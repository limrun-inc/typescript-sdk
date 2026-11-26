import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class MacosLaunchApp extends BaseCommand {
  static summary = 'Launch an app on a macOS instance';
  static description =
    'Launch an app in the macOS guest by bundle ID (com.apple.TextEdit), name (TextEdit) or path ' +
    '(/Applications/Safari.app), and bring it to the front. An app launched this way has its stdout and stderr in its ' +
    '`lim macos app-log`. Arguments and environment variables apply when the app starts, so pass ' +
    '`--mode RelaunchIfRunning` to apply them to an app that already runs.';
  static examples = [
    '<%= config.bin %> macos launch-app com.apple.TextEdit',
    '<%= config.bin %> macos launch-app Safari',
    '<%= config.bin %> macos launch-app com.example.app --env API_URL=https://example.com --arg -v',
    '<%= config.bin %> macos launch-app com.example.app --mode RelaunchIfRunning',
  ];

  static args = {
    app: Args.string({ description: 'Bundle ID, app name or .app path', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    mode: Flags.string({
      description:
        'What to do when the app already runs: bring it to the front (ForegroundIfRunning) or stop and start it again (RelaunchIfRunning).',
      options: ['ForegroundIfRunning', 'RelaunchIfRunning'],
      default: 'ForegroundIfRunning',
    }),
    arg: Flags.string({
      description: 'A command-line argument for the app; repeat for more.',
      multiple: true,
      multipleNonGreedy: true,
    }),
    env: Flags.string({
      description: 'An environment variable for the app as KEY=VALUE; repeat for more.',
      multiple: true,
      multipleNonGreedy: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosLaunchApp);
    this.setParsedFlags(flags);
    const env: Record<string, string> = {};
    for (const assignment of flags.env ?? []) {
      const equals = assignment.indexOf('=');
      if (equals <= 0) this.error(`--env takes KEY=VALUE, got ${assignment}`);
      env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
    }
    await this.withAuth(async () => {
      const { client } = await this.resolveMacosClient(flags.id);
      const result = await client.launchApp(args.app, {
        mode: flags.mode as 'ForegroundIfRunning' | 'RelaunchIfRunning',
        ...(flags.arg?.length && { arguments: flags.arg }),
        ...(flags.env?.length && { env }),
      });
      this.outputResult(
        result,
        result.launched ?
          `Launched ${result.bundleId} (pid ${result.pid})`
        : `${result.bundleId} was already running (pid ${result.pid}); brought it to the front`,
      );
    });
  }
}
