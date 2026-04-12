import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendCommand } from '../../lib/instance-client-factory';

export default class ExecTerminateApp extends BaseCommand {
  static summary = 'Terminate an app on a running iOS instance';
  static examples = ['<%= config.bin %> exec terminate-app <instance-ID> com.example.app'];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
    bundleId: Args.string({ description: 'App bundle identifier', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecTerminateApp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (hasActiveSession(args.id)) {
        await sendCommand('terminate-app', [args.bundleId]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, args.id);
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
