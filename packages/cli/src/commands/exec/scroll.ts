import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecScroll extends BaseCommand {
  static summary = 'Scroll on a running instance';
  static aliases = ['ios scroll', 'android scroll'];
  static examples = ['<%= config.bin %> ios scroll <instance-ID> down --amount 500'];

  static args = {
    direction: Args.string({
      description: 'Scroll direction',
      required: true,
      options: ['up', 'down', 'left', 'right'],
    }),
    id: Args.string({ description: 'Instance ID (defaults to last created)', required: false }),
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
      const id = this.resolveId(args.id);
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
