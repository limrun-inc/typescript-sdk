import { Args, Flags } from '@oclif/core';
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
    'Launch an installed app on a running iOS instance by bundle identifier. Choose `ForegroundIfRunning` to bring an already-running app to the front or `RelaunchIfRunning` to restart it. Use `--runtime detox` to launch with the Limrun-managed Detox runtime.';
  static examples = [
    '<%= config.bin %> ios launch-app com.example.app',
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
    });
  }
}
