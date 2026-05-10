import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosLaunchApp extends BaseCommand {
  static summary = 'Launch an app on a running iOS instance';
  static description =
    'Launch an installed app on a running iOS instance by bundle identifier. Choose `ForegroundIfRunning` to bring an already-running app to the front or `RelaunchIfRunning` to restart it.';
  static examples = [
    '<%= config.bin %> ios launch-app com.example.app',
    '<%= config.bin %> ios launch-app com.example.app --mode RelaunchIfRunning --id <instance-ID>',
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
      description: 'Launch behavior to use when the app may already be running',
      options: ['ForegroundIfRunning', 'RelaunchIfRunning'],
      default: 'ForegroundIfRunning',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosLaunchApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'launch-app', [args.bundleId, flags.mode]);
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          await client.launchApp(
            args.bundleId,
            flags.mode as 'ForegroundIfRunning' | 'RelaunchIfRunning' | undefined,
          );
        } finally {
          disconnect();
        }
      }
      this.log(`Launched ${args.bundleId}`);
    });
  }
}
