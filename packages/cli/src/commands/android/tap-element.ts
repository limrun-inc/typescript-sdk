import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { androidSelectorFlags, buildAndroidSelector } from '../../lib/android-selector';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidTapElement extends BaseCommand {
  static summary = 'Tap an Android element by selector';
  static description =
    'Find an element on the current Android screen and tap it using the native Android selector fields.';
  static examples = [
    '<%= config.bin %> android tap-element --resource-id com.example:id/submit',
    '<%= config.bin %> android tap-element --text "Sign In"',
    '<%= config.bin %> android tap-element --content-desc "Submit button"',
    '<%= config.bin %> android tap-element --class-name android.widget.Button --enabled',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    ...androidSelectorFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidTapElement);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android tap-element only supports Android instances');
      }

      const selector = buildAndroidSelector(flags);
      if (!selector) {
        this.error(
          'Provide at least one Android selector flag such as --resource-id, --text, --content-desc, or --class-name.',
        );
      }

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
