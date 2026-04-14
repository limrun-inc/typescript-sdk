import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class IosLaunchApp extends BaseCommand {
  static summary = 'Launch an app on a running iOS instance';
  static aliases = ['exec launch-app'];
  static examples = [
    '<%= config.bin %> ios launch-app <instance-ID> com.example.app',
    '<%= config.bin %> ios launch-app <instance-ID> com.example.app --mode RelaunchIfRunning',
  ];

  static args = {
    bundleId: Args.string({ description: 'App bundle identifier', required: true }),
    id: Args.string({ description: 'Instance ID (defaults to last created)', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    mode: Flags.string({
      description: 'Launch mode',
      options: ['ForegroundIfRunning', 'RelaunchIfRunning'],
      default: 'ForegroundIfRunning',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosLaunchApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'launch-app', [args.bundleId, flags.mode]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        if (type !== 'ios') {
          disconnect();
          this.error('launch-app is only supported on iOS instances');
        }
        try {
          await (client as any).launchApp(args.bundleId, flags.mode);
        } finally {
          disconnect();
        }
      }
      this.log(`Launched ${args.bundleId}`);
    });
  }
}
