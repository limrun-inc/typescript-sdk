import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecTap extends BaseCommand {
  static summary = 'Tap at coordinates on a running instance';
  static aliases = ['ios tap', 'android tap', 'tap'];
  static examples = ['<%= config.bin %> ios tap <instance-ID> 100 200'];

  static args = {
    x: Args.integer({ description: 'X coordinate', required: true }),
    y: Args.integer({ description: 'Y coordinate', required: true }),
    id: Args.string({ description: 'Instance ID (defaults to last created)', required: false }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecTap);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'tap', [args.x, args.y]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
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
