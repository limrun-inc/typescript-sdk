import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosTapElement extends BaseCommand {
  static summary = 'Tap an iOS element by accessibility selector';
  static description =
    'Find an element on the current iOS screen and tap it using accessibility metadata such as the visible label or accessibility identifier.';
  static examples = [
    '<%= config.bin %> ios tap-element --label "Submit"',
    '<%= config.bin %> ios tap-element --accessibility-id login_button --id <instance-ID>',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    label: Flags.string({
      description: 'Visible accessibility label to match, such as the AXLabel shown on screen.',
    }),
    'accessibility-id': Flags.string({
      description: 'Accessibility identifier to match, such as a stable test hook.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosTapElement);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios tap-element only supports iOS instances');
      }

      const selector: Record<string, string> = {};
      if (flags.label) selector.label = flags.label;
      if (flags['accessibility-id']) selector.accessibilityId = flags['accessibility-id'];

      if (hasActiveSession(id)) {
        const result = await sendSessionCommand(id, 'tap-element', [selector]);
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'ios') {
          this.error('ios tap-element only supports iOS instances');
        }
        const result = await (client as any).tapElement(selector);
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
      } finally {
        disconnect();
      }
    });
  }
}
