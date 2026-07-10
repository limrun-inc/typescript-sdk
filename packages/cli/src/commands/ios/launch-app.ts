import { Args, Flags } from '@oclif/core';
import type { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';
import {
  buildLaunchAppArgument,
  type LaunchAppArgument,
  type LaunchAppFlagValues,
} from '../../lib/launch-app-runtime';

type IosLaunchClient = Awaited<ReturnType<typeof getIosInstanceClient>>['client'];

async function launchAppWithArgument(
  client: IosLaunchClient,
  bundleId: string,
  launchArgument: LaunchAppArgument,
): Promise<void> {
  if (typeof launchArgument === 'string') {
    await client.launchApp(bundleId, launchArgument);
    return;
  }
  await client.launchApp(bundleId, launchArgument);
}

export default class IosLaunchApp extends BaseCommand {
  static summary = 'Launch an app on a running iOS instance';
  static description =
    'Launch an installed app on a running iOS instance by bundle identifier and stream its logs until the app exits or the command is interrupted. Use `--detach` to exit immediately after the launch instead. Choose `ForegroundIfRunning` to bring an already-running app to the front or `RelaunchIfRunning` to restart it. Use `--runtime detox` to launch with the Limrun-managed Detox runtime.';
  static examples = [
    '<%= config.bin %> ios launch-app com.example.app',
    '<%= config.bin %> ios launch-app com.example.app --detach',
    '<%= config.bin %> ios launch-app com.example.app --mode RelaunchIfRunning --id <instance-ID>',
    '<%= config.bin %> ios launch-app host.exp.Exponent --runtime detox --detox-server-url ws://10.244.0.10:57091 --detox-session-id limrun-detox --detox-version 20.51.1 --id <instance-ID>',
  ];

  static args = {
    bundleId: Args.string({ description: 'App bundle identifier', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    detach: Flags.boolean({
      char: 'd',
      description: 'Exit right after launching instead of streaming app logs',
      default: false,
    }),
    mode: Flags.string({
      description:
        'Launch behavior to use when the app may already be running. Default: ForegroundIfRunning.',
      options: ['ForegroundIfRunning', 'RelaunchIfRunning'],
    }),
    runtime: Flags.string({
      description: 'Runtime integration to attach during launch',
      options: ['detox'],
    }),
    'detox-server-url': Flags.string({
      description: 'Detox mediator URL reachable from the simulator, usually from `lim ios reverse`',
    }),
    'detox-session-id': Flags.string({
      description: 'Detox session ID shared by the app and tester',
    }),
    'detox-version': Flags.string({
      description:
        'Exact Detox version for Limrun-managed native injection. Defaults to the detox package in the current working directory.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosLaunchApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      const launchArgument = buildLaunchAppArgument(flags as LaunchAppFlagValues, {
        modeExplicitlyProvided: flags.mode !== undefined,
      });

      if (flags.detach) {
        if (hasActiveSession(id)) {
          await sendSessionCommand(id, 'launch-app', [args.bundleId, launchArgument]);
        } else {
          const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
          try {
            await launchAppWithArgument(client, args.bundleId, launchArgument);
          } finally {
            disconnect();
          }
        }
        this.log(`Launched ${args.bundleId}`);
        return;
      }

      // Log streaming always needs a direct connection, even when a daemon
      // session is active for the instance. The launch also goes through the
      // direct client because the appExit notification that ends this command
      // is delivered on the launching client's signaling WebSocket.
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        // Subscribe before launching so early log lines are not missed.
        const logStream = client.streamAppLog(args.bundleId);
        logStream.on('line', (line: string) => {
          process.stdout.write(line + '\n');
        });
        logStream.on('error', (err: Error) => {
          this.warn(`App log stream error: ${err.message}`);
        });

        let notifyAppExited: () => void = () => {};
        const appExited = new Promise<void>((resolve) => {
          notifyAppExited = resolve;
        });
        const launchOptions: Ios.LaunchAppOptions = {
          ...(typeof launchArgument === 'string' ? { mode: launchArgument } : launchArgument),
          onExit: async () => {
            notifyAppExited();
          },
        };

        try {
          await client.launchApp(args.bundleId, launchOptions);
        } catch (error) {
          logStream.stop();
          throw error;
        }

        this.logToStderr(
          `Launched ${args.bundleId}. Streaming app logs until the app exits; press Ctrl+C to stop earlier, or pass --detach to skip streaming.`,
        );

        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          const finish = () => {
            clearInterval(keepAlive);
            logStream.stop();
            resolve();
          };
          process.on('SIGINT', finish);
          process.on('SIGTERM', finish);
          logStream.on('close', finish);
          void appExited.then(() => {
            this.logToStderr(`${args.bundleId} exited.`);
            // Log lines arrive in ~500ms batches; give the tail a moment to flush.
            setTimeout(finish, 1000);
          });
        });
      } finally {
        disconnect();
      }
    });
  }
}
