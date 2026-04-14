import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecPressKey extends BaseCommand {
  static summary = 'Press a key on a running instance';
  static aliases = ['ios press-key', 'android press-key'];
  static examples = [
    '<%= config.bin %> ios press-key <instance-ID> enter',
    '<%= config.bin %> ios press-key <instance-ID> a --modifier shift',
  ];

  static args = {
    key: Args.string({ description: 'Key to press (e.g. enter, backspace, a, f1)', required: true }),
    id: Args.string({ description: 'Instance ID (defaults to last created)', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    modifier: Flags.string({ description: 'Modifier key (e.g. shift, command, alt)', multiple: true }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecPressKey);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'press-key', [args.key, flags.modifier]);
      } else {
        const { client, disconnect } = await getInstanceClient(this.client, id);
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
