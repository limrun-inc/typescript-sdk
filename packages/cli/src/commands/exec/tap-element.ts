import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecTapElement extends BaseCommand {
  static summary = 'Tap an element by accessibility selector';
  static aliases = ['ios tap-element', 'android tap-element'];
  static examples = [
    '<%= config.bin %> ios tap-element --label "Submit"',
    '<%= config.bin %> android tap-element --accessibility-id btn_ok --id <instance-ID>',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Instance ID (defaults to last created)' }),
    label: Flags.string({ description: 'Element label text' }),
    'accessibility-id': Flags.string({ description: 'Accessibility identifier' }),
    'resource-id': Flags.string({ description: 'Android resource ID' }),
    text: Flags.string({ description: 'Android text content' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ExecTapElement);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      const type = id.split('_')[0];

      if (hasActiveSession(id)) {
        const selector: Record<string, string> = {};
        if (type === 'ios') {
          if (flags.label) selector.label = flags.label;
          if (flags['accessibility-id']) selector.accessibilityId = flags['accessibility-id'];
        } else {
          if (flags.label) selector.contentDesc = flags.label;
          if (flags['resource-id']) selector.resourceId = flags['resource-id'];
          if (flags.text) selector.text = flags.text;
          if (flags['accessibility-id']) selector.resourceId = flags['accessibility-id'];
        }
        const result = await sendSessionCommand(id, 'tap-element', [selector]);
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type === 'ios') {
            const selector: Record<string, string> = {};
            if (flags.label) selector.label = flags.label;
            if (flags['accessibility-id']) selector.accessibilityId = flags['accessibility-id'];
            const result = await (client as any).tapElement(selector);
            if (flags.json) this.outputJson(result);
            else this.log('Element tapped');
          } else {
            const selector: Record<string, string> = {};
            if (flags.label) selector.contentDesc = flags.label;
            if (flags['resource-id']) selector.resourceId = flags['resource-id'];
            if (flags.text) selector.text = flags.text;
            if (flags['accessibility-id']) selector.resourceId = flags['accessibility-id'];
            const result = await (client as any).tap({ selector });
            if (flags.json) this.outputJson(result);
            else this.log('Element tapped');
          }
        } finally {
          disconnect();
        }
      }
    });
  }
}
