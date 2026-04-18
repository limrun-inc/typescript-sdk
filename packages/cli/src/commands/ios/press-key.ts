import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosPressKey extends BaseCommand {
  static summary = 'Press a key on a running iOS instance';
  static description =
    'Send a keyboard key press to the focused app or text field on a running iOS instance. You can repeat `--modifier` to combine keys such as Command, Shift, or Alt.';
  static examples = [
    '<%= config.bin %> ios press-key enter',
    '<%= config.bin %> ios press-key a --modifier shift --id <instance-ID>',
  ];

  static args = {
    key: Args.string({ description: 'Key to press (e.g. enter, backspace, a, f1)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    modifier: Flags.string({
      description:
        'Modifier key to hold during the press, such as shift, command, control, or alt. Repeat for multiple modifiers.',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosPressKey);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios press-key only supports iOS instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'press-key', [args.key, flags.modifier]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'ios') {
            this.error('ios press-key only supports iOS instances');
          }
          await (client as any).pressKey(args.key, flags.modifier);
        } finally {
          disconnect();
        }
      }
      this.log(`Pressed key: ${args.key}`);
    });
  }
}
