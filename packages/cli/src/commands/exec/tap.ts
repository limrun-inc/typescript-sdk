import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecTap extends BaseCommand {
  static summary = 'Tap at coordinates on a running instance';
  static description =
    'Tap a specific coordinate on the current screen of a running iOS or Android instance. Use this when element selectors are unavailable or when automating canvas-style UIs.';
  static examples = [
    '<%= config.bin %> ios tap 100 200',
    '<%= config.bin %> ios tap 100 200 --id <instance-ID>',
    '<%= config.bin %> android tap 540 1200',
  ];

  static args = {
    x: Args.integer({
      description: 'X coordinate in screen points or pixels for the current device view',
      required: true,
    }),
    y: Args.integer({
      description: 'Y coordinate in screen points or pixels for the current device view',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Instance ID to target. Defaults to the last created instance of the command alias type.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecTap);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
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
