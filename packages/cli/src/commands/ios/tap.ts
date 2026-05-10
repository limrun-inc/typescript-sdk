import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosTap extends BaseCommand {
  static summary = 'Tap at coordinates on a running iOS instance';
  static description =
    'Tap a specific coordinate on the current screen of a running iOS instance. Use this when element selectors are unavailable or when automating canvas-style UIs.';
  static examples = [
    '<%= config.bin %> ios tap 100 200',
    '<%= config.bin %> ios tap 100 200 --id <instance-ID>',
  ];

  static args = {
    x: Args.integer({
      description: 'X coordinate in screen points for the current device view',
      required: true,
    }),
    y: Args.integer({
      description: 'Y coordinate in screen points for the current device view',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosTap);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('ios tap only supports iOS instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'tap', [args.x, args.y]);
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          await client.tap(args.x, args.y);
        } finally {
          disconnect();
        }
      }
      this.log(`Tapped at (${args.x}, ${args.y})`);
    });
  }
}
