import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosScroll extends BaseCommand {
  static summary = 'Scroll on a running iOS instance';
  static description =
    'Scroll the current screen on a running iOS instance. The amount is interpreted as pixels.';
  static examples = [
    '<%= config.bin %> ios scroll down --amount 500',
    '<%= config.bin %> ios scroll down --amount 500 --id <instance-ID>',
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
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    amount: Flags.integer({
      description: 'Scroll amount in pixels.',
      default: 300,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosScroll);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('ios scroll only supports iOS instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'scroll', [args.direction, flags.amount]);
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          const direction = args.direction as 'up' | 'down' | 'left' | 'right';
          await client.scroll(direction, flags.amount);
        } finally {
          disconnect();
        }
      }
      this.log(`Scrolled ${args.direction}`);
    });
  }
}
