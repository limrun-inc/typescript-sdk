import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { androidTargetFlags, buildAndroidTarget } from '../../lib/android-selector';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidType extends BaseCommand {
  static summary = 'Type text into an Android input field';
  static description =
    'Type text into the currently focused Android input field, or target a specific element by selector or coordinates when the focused field is not enough.';
  static examples = [
    '<%= config.bin %> android type "Hello World"',
    '<%= config.bin %> android type "search query" --id <instance-ID>',
    '<%= config.bin %> android type "search query" --resource-id com.example:id/search_input',
    '<%= config.bin %> android type "hello" --x 120 --y 340',
  ];

  static args = {
    text: Args.string({ description: 'Text to type into the focused field', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    ...androidTargetFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidType);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android type only supports Android instances');
      }

      const target = buildAndroidTarget(flags);

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'type', [target, args.text]);
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'android') {
            this.error('android type only supports Android instances');
          }
          await (client as any).setText(target, args.text);
        } finally {
          disconnect();
        }
      }
      this.log('Text typed');
    });
  }
}
