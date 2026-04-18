import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidTapElement extends BaseCommand {
  static summary = 'Tap an Android element by selector';
  static description =
    'Find an element on the current Android screen and tap it using selector fields such as content description, resource ID, or visible text.';
  static examples = [
    '<%= config.bin %> android tap-element --resource-id com.example:id/submit',
    '<%= config.bin %> android tap-element --text "Sign In"',
    '<%= config.bin %> android tap-element --accessibility-id btn_ok --id <instance-ID>',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    label: Flags.string({
      description: 'Visible accessibility label to match, treated as Android content description.',
    }),
    'accessibility-id': Flags.string({
      description: 'Accessibility identifier to match, mapped to Android resource ID matching.',
    }),
    'resource-id': Flags.string({
      description: 'Android resource ID to match, such as com.example:id/submit',
    }),
    text: Flags.string({ description: 'Android visible text to match exactly' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidTapElement);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android tap-element only supports Android instances');
      }

      const selector: Record<string, string> = {};
      if (flags.label) selector.contentDesc = flags.label;
      if (flags['resource-id']) selector.resourceId = flags['resource-id'];
      if (flags.text) selector.text = flags.text;
      if (flags['accessibility-id']) selector.resourceId = flags['accessibility-id'];

      if (hasActiveSession(id)) {
        const result = await sendSessionCommand(id, 'tap-element', [selector]);
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'android') {
          this.error('android tap-element only supports Android instances');
        }
        const result = await (client as any).tap({ selector });
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
      } finally {
        disconnect();
      }
    });
  }
}
