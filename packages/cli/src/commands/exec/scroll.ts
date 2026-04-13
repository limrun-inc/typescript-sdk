import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecScroll extends BaseCommand {
  static summary = 'Scroll on a running instance';
  static examples = ['<%= config.bin %> exec scroll <instance-ID> down --amount 500'];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
    direction: Args.string({
      description: 'Scroll direction',
      required: true,
      options: ['up', 'down', 'left', 'right'],
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    amount: Flags.integer({
      description: 'Scroll amount (pixels for iOS, abstract units for Android)',
      default: 300,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecScroll);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (hasActiveSession(args.id)) {
        await sendSessionCommand(args.id, 'scroll', [args.direction, flags.amount]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, args.id);
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
