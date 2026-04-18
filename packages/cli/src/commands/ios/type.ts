import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosType extends BaseCommand {
  static summary = 'Type text into the focused iOS input field';
  static description =
    'Type text into the currently focused input field on a running iOS instance. Use `--enter` to submit the field after typing.';
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
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    enter: Flags.boolean({
      description: 'Press Enter after typing.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosType);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios type only supports iOS instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'type', [args.text, flags.enter]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'ios') {
            this.error('ios type only supports iOS instances');
          }
          await (client as any).typeText(args.text, flags.enter);
        } finally {
          disconnect();
        }
      }
      this.log('Text typed');
    });
  }
}
