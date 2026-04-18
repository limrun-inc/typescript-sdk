import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecType extends BaseCommand {
  static summary = 'Type text into the focused input field';
  static description =
    'Type text into the currently focused input field on a running iOS or Android instance. On iOS, `--enter` can submit the field after typing.';
  static aliases = ['ios type', 'android type'];
  static examples = [
    '<%= config.bin %> ios type "Hello World"',
    '<%= config.bin %> ios type "Hello World" --id <instance-ID>',
    '<%= config.bin %> ios type "search query" --enter',
  ];

  static args = {
    text: Args.string({ description: 'Text to type into the focused field', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Instance ID to target. Defaults to the last created instance of the command alias type.',
    }),
    enter: Flags.boolean({
      description: 'Press Enter after typing on iOS. Ignored on Android.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecType);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'type', [args.text, flags.enter]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type === 'ios') {
            await (client as any).typeText(args.text, flags.enter);
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
