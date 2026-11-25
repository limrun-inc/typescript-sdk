import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class MacosAppLog extends BaseCommand {
  static summary = "Tail or follow an app's log on a macOS instance";
  static description =
    "Read an installed app's log: its stdout and stderr when `lim macos launch-app` started it, and its messages in the " +
    "guest's unified log, without those of Apple's frameworks unless the app is Apple's. Without `--follow`, print " +
    'the last lines from the past hour; with it, keep printing lines as the app writes them until interrupted.';
  static examples = [
    '<%= config.bin %> macos app-log com.apple.TextEdit',
    '<%= config.bin %> macos app-log com.example.app --tail 50',
    '<%= config.bin %> macos app-log com.example.app --follow',
  ];

  static args = {
    bundleId: Args.string({ description: 'Bundle identifier of the installed app.', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    follow: Flags.boolean({
      char: 'f',
      description: 'Keep printing messages until interrupted.',
      default: false,
    }),
    tail: Flags.integer({
      char: 'n',
      description: 'Number of recent lines to print when not using `--follow`.',
      default: 100,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosAppLog);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const { client } = await this.resolveMacosClient(flags.id);
      if (!flags.follow) {
        const output = await client.appLogTail(args.bundleId, flags.tail);
        this.outputResult({ stdout: output }, output);
        return;
      }
      const keepAlive = setInterval(() => {}, 1 << 30);
      let stop = () => {};
      let interrupted = () => {};
      try {
        await new Promise<void>((resolve, reject) => {
          interrupted = () => resolve();
          process.once('SIGINT', interrupted);
          process.once('SIGTERM', interrupted);
          stop = client.streamAppLog(args.bundleId, {
            onEntry: (line) => {
              if (flags.json) this.outputEvent({ line });
              else process.stdout.write(line + '\n');
            },
            onError: reject,
          });
        });
      } finally {
        process.off('SIGINT', interrupted);
        process.off('SIGTERM', interrupted);
        clearInterval(keepAlive);
        stop();
      }
    });
  }
}
