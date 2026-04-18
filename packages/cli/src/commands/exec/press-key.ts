import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecPressKey extends BaseCommand {
  static summary = 'Press a key on a running instance';
  static description =
    'Send a keyboard key press to the focused app or text field on a running iOS or Android instance. You can repeat `--modifier` to combine keys such as Command, Shift, or Alt.';
  static examples = [
    '<%= config.bin %> ios press-key enter',
    '<%= config.bin %> ios press-key a --modifier shift --id <instance-ID>',
    '<%= config.bin %> android press-key tab',
  ];

  static args = {
    key: Args.string({ description: 'Key to press (e.g. enter, backspace, a, f1)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Instance ID to target. Defaults to the last created instance of the command alias type.',
    }),
    modifier: Flags.string({
      description:
        'Modifier key to hold during the press, such as shift, command, control, or alt. Repeat for multiple modifiers.',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecPressKey);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
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
