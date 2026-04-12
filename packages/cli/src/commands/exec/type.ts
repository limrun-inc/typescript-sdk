import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendCommand } from '../../lib/instance-client-factory';

export default class ExecType extends BaseCommand {
  static summary = 'Type text into the focused input field';
  static examples = ['<%= config.bin %> exec type <instance-ID> "Hello World"'];

  static args = {
    id: Args.string({ description: 'Instance ID', required: true }),
    text: Args.string({ description: 'Text to type', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'press-enter': Flags.boolean({ description: 'Press Enter after typing (iOS only)', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecType);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (hasActiveSession(args.id)) {
        await sendCommand('type', [args.text, flags['press-enter']]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, args.id);
        try {
          if (type === 'ios') {
            await (client as any).typeText(args.text, flags['press-enter']);
          } else {
            await (client as any).setText(undefined, args.text);
          }
        } finally {
          disconnect();
        }
      }
      this.log('Text typed');
    });
  }
}
