import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecLaunchApp extends BaseCommand {
  static summary = 'Launch an app on a running iOS instance';
  static examples = [
    '<%= config.bin %> exec launch-app <instance-ID> com.example.app',
    '<%= config.bin %> exec launch-app <instance-ID> com.example.app --mode RelaunchIfRunning',
  ];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
    bundleId: Args.string({ description: 'App bundle identifier', required: true }),
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
    const { args, flags } = await this.parse(ExecLaunchApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (hasActiveSession(args.id)) {
        await sendSessionCommand(args.id, 'launch-app', [args.bundleId, flags.mode]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, args.id);
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
