import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidType extends BaseCommand {
  static summary = 'Type text into the focused Android input field';
  static description =
    'Type text into the currently focused input field on a running Android instance by replacing the current text content.';
  static examples = [
    '<%= config.bin %> android type "Hello World"',
    '<%= config.bin %> android type "search query" --id <instance-ID>',
  ];

  static args = {
    text: Args.string({ description: 'Text to type into the focused field', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidType);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android type only supports Android instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'type', [args.text, false]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'android') {
            this.error('android type only supports Android instances');
          }
          await (client as any).setText(undefined, args.text);
        } finally {
          disconnect();
        }
      }
      this.log('Text typed');
    });
  }
}
