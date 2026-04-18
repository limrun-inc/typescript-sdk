import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidPressKey extends BaseCommand {
  static summary = 'Press a key on a running Android instance';
  static description =
    'Send a keyboard key press to the focused app or text field on a running Android instance. You can repeat `--modifier` to provide modifier keys when supported.';
  static examples = [
    '<%= config.bin %> android press-key enter',
    '<%= config.bin %> android press-key tab --id <instance-ID>',
  ];

  static args = {
    key: Args.string({ description: 'Key to press (e.g. enter, backspace, a, f1)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    modifier: Flags.string({
      description:
        'Modifier key to hold during the press, such as shift, command, control, or alt. Repeat for multiple modifiers.',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidPressKey);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android press-key only supports Android instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'press-key', [args.key, flags.modifier]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'android') {
            this.error('android press-key only supports Android instances');
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
