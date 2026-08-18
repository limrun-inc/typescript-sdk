import { Args, Flags } from '@oclif/core';
import type { AppExitInfo, LaunchAppMode } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';
import { formatAppExit } from '../../lib/format-app-exit';

export default class AndroidLaunchApp extends BaseCommand {
  static summary = 'Launch an app on a running Android instance';
  static description =
    'Launch an installed app on a running Android instance by package name and watch it until it exits: when the app crashes, ANRs, or stops, the exit reason, crash details, and a recent app log tail are printed. Use `--detach` to exit right after the launch instead. Choose `ForegroundIfRunning` to bring an already-running app to the front or `RelaunchIfRunning` to restart it.';
  static examples = [
    '<%= config.bin %> android launch-app com.example.app',
    '<%= config.bin %> android launch-app com.example.app --detach',
    '<%= config.bin %> android launch-app com.example.app --mode RelaunchIfRunning --id <instance-ID>',
  ];

  static args = {
    packageName: Args.string({ description: 'Package name of the app to launch', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    detach: Flags.boolean({
      char: 'd',
      description: 'Exit right after launching instead of watching until the app exits',
      default: false,
    }),
    mode: Flags.string({
      description:
        'Launch behavior to use when the app may already be running. Default: ForegroundIfRunning.',
      options: ['ForegroundIfRunning', 'RelaunchIfRunning'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidLaunchApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const mode = flags.mode as LaunchAppMode | undefined;

      // The appExit notification that ends this command is delivered on the
      // launching client's signaling WebSocket, so both paths use a direct
      // connection rather than a daemon session.
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        if (flags.detach) {
          await client.launchApp(args.packageName, { mode });
          this.log(`Launched ${args.packageName}`);
          return;
        }

        let notifyAppExited: () => void = () => {};
        const appExited = new Promise<void>((resolve) => {
          notifyAppExited = resolve;
        });

        await client.launchApp(args.packageName, {
          mode,
          onExit: (logs: string[], info: AppExitInfo) => {
            this.log(formatAppExit(info, logs));
            notifyAppExited();
          },
        });

        this.logToStderr(
          `Launched ${args.packageName}. Watching until the app exits; press Ctrl+C to stop earlier, or pass --detach to skip watching.`,
        );

        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          const finish = () => {
            clearInterval(keepAlive);
            resolve();
          };
          process.on('SIGINT', finish);
          process.on('SIGTERM', finish);
          void appExited.then(finish);
        });
      } finally {
        disconnect();
      }
    });
  }
}
