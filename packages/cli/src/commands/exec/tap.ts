import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendCommand } from '../../lib/instance-client-factory';

export default class ExecTap extends BaseCommand {
  static summary = 'Tap at coordinates on a running instance';
  static examples = ['<%= config.bin %> exec tap <instance-ID> 100 200'];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
    x: Args.integer({ description: 'X coordinate', required: true }),
    y: Args.integer({ description: 'Y coordinate', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecTap);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (hasActiveSession(args.id)) {
        await sendCommand('tap', [args.x, args.y]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, args.id);
        try {
          if (type === 'ios') {
            await (client as any).tap(args.x, args.y);
          } else {
            await (client as any).tap({ x: args.x, y: args.y });
          }
        } finally {
          disconnect();
        }
      }
      this.log(`Tapped at (${args.x}, ${args.y})`);
    });
  }
}
