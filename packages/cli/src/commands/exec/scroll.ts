import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecScroll extends BaseCommand {
  static summary = 'Scroll on a running instance';
  static description =
    'Scroll the current screen on a running iOS or Android instance. The amount uses pixels on iOS and the Android client scroll units on Android.';
  static examples = [
    '<%= config.bin %> ios scroll down --amount 500',
    '<%= config.bin %> ios scroll down --amount 500 --id <instance-ID>',
    '<%= config.bin %> android scroll up --amount 300',
  ];

  static args = {
    direction: Args.string({
      description: 'Scroll direction to apply',
      required: true,
      options: ['up', 'down', 'left', 'right'],
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Instance ID to target. Defaults to the last created instance of the command alias type.',
    }),
    amount: Flags.integer({
      description: 'Scroll amount. Uses pixels on iOS and Android scroll units on Android.',
      default: 300,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecScroll);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'scroll', [args.direction, flags.amount]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type === 'ios') {
            await (client as any).scroll(args.direction, flags.amount);
          } else {
            await (client as any).scrollScreen(args.direction, flags.amount);
          }
        } finally {
          disconnect();
        }
      }
      this.log(`Scrolled ${args.direction}`);
    });
  }
}
