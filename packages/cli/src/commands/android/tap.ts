import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidTap extends BaseCommand {
  static summary = 'Tap at coordinates on a running Android instance';
  static description =
    'Tap a specific coordinate on the current screen of a running Android instance. Use this when element selectors are unavailable or when automating canvas-style UIs.';
  static examples = [
    '<%= config.bin %> android tap 540 1200',
    '<%= config.bin %> android tap 540 1200 --id <instance-ID>',
  ];

  static args = {
    x: Args.integer({
      description: 'X coordinate in screen pixels for the current device view',
      required: true,
    }),
    y: Args.integer({
      description: 'Y coordinate in screen pixels for the current device view',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidTap);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android tap only supports Android instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'tap', [args.x, args.y]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'android') {
            this.error('android tap only supports Android instances');
          }
          await (client as any).tap({ x: args.x, y: args.y });
        } finally {
          disconnect();
        }
      }
      this.log(`Tapped at (${args.x}, ${args.y})`);
    });
  }
}
