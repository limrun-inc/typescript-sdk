import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendCommand } from '../../lib/instance-client-factory';

export default class ExecPressKey extends BaseCommand {
  static summary = 'Press a key on a running instance';
  static examples = [
    '<%= config.bin %> exec press-key <instance-ID> enter',
    '<%= config.bin %> exec press-key <instance-ID> a --modifier shift',
  ];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
    key: Args.string({ description: 'Key to press (e.g. enter, backspace, a, f1)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    modifier: Flags.string({ description: 'Modifier key (e.g. shift, command, alt)', multiple: true }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecPressKey);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (hasActiveSession(args.id)) {
        await sendCommand('press-key', [args.key, flags.modifier]);
      } else {
        const { client, disconnect } = await getInstanceClient(this.client, args.id);
        try {
          await (client as any).pressKey(args.key, flags.modifier);
        } finally {
          disconnect();
        }
      }
      this.log(`Pressed key: ${args.key}`);
    });
  }
}
