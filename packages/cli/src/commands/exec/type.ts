import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecType extends BaseCommand {
  static summary = 'Type text into the focused input field';
  static aliases = ['ios type', 'android type'];
  static examples = ['<%= config.bin %> ios type <instance-ID> "Hello World"'];

  static args = {
    text: Args.string({ description: 'Text to type', required: true }),
    id: Args.string({ description: 'Instance ID (defaults to last created)', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'press-enter': Flags.boolean({ description: 'Press Enter after typing (iOS only)', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecType);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'type', [args.text, flags['press-enter']]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
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
