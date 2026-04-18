import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class IosTerminateApp extends BaseCommand {
  static summary = 'Terminate an app on a running iOS instance';
  static description =
    'Stop a running app on an iOS instance by bundle identifier. This is useful when resetting application state or ending a foreground app before another automation step.';
  static aliases = ['exec terminate-app'];
  static examples = [
    '<%= config.bin %> ios terminate-app com.example.app',
    '<%= config.bin %> ios terminate-app com.example.app --id <instance-ID>',
    '<%= config.bin %> ios terminate-app com.example.app --id ios_abc123',
  ];

  static args = {
    bundleId: Args.string({
      description: 'Bundle identifier of the running app to terminate',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosTerminateApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'terminate-app', [args.bundleId]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        if (type !== 'ios') {
          disconnect();
          this.error('terminate-app is only supported on iOS instances');
        }
        try {
          await (client as any).terminateApp(args.bundleId);
        } finally {
          disconnect();
        }
      }
      this.log(`Terminated ${args.bundleId}`);
    });
  }
}
