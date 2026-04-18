import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { androidTargetFlags, buildAndroidTarget } from '../../lib/android-selector';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidScroll extends BaseCommand {
  static summary = 'Scroll on a running Android instance';
  static description =
    'Scroll the current screen on a running Android instance, or scroll inside a matched element by selector or coordinates. The amount uses Android client scroll units.';
  static examples = [
    '<%= config.bin %> android scroll up --amount 300',
    '<%= config.bin %> android scroll down --amount 500 --id <instance-ID>',
    '<%= config.bin %> android scroll down --resource-id com.example:id/list --amount 500',
    '<%= config.bin %> android scroll up --x 120 --y 500 --amount 250',
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
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    ...androidTargetFlags,
    amount: Flags.integer({
      description: 'Scroll amount in Android scroll units.',
      default: 300,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidScroll);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android scroll only supports Android instances');
      }

      const target = buildAndroidTarget(flags);

      if (hasActiveSession(id)) {
        if (target) {
          await sendSessionCommand(id, 'scroll', [target, args.direction, flags.amount]);
        } else {
          await sendSessionCommand(id, 'scroll', [args.direction, flags.amount]);
        }
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'android') {
            this.error('android scroll only supports Android instances');
          }
          if (target) {
            await (client as any).scrollElement(target, args.direction, flags.amount);
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
