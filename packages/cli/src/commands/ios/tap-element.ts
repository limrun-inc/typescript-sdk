import { Flags } from '@oclif/core';
import { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosTapElement extends BaseCommand {
  static summary = 'Tap an iOS element by accessibility selector';
  static description =
    'Find an element on the current iOS screen and tap it using the native iOS accessibility selector fields.';
  static examples = [
    '<%= config.bin %> ios tap-element --ax-label "Submit"',
    '<%= config.bin %> ios tap-element --ax-unique-id login_button --id <instance-ID>',
    '<%= config.bin %> ios tap-element --type Button --title "Continue"',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    'ax-unique-id': Flags.string({
      description: 'Match by `AXUniqueId` (accessibilityIdentifier) using an exact match.',
    }),
    'ax-label': Flags.string({
      description: 'Match by `AXLabel` using an exact match.',
    }),
    'ax-label-contains': Flags.string({
      description: 'Match by `AXLabelContains` using a case-insensitive contains query.',
    }),
    type: Flags.string({
      description: 'Match by element type/role, such as `Button` or `TextField`.',
    }),
    title: Flags.string({
      description: 'Match by title using an exact match.',
    }),
    'title-contains': Flags.string({
      description: 'Match by `titleContains` using a case-insensitive contains query.',
    }),
    'ax-value': Flags.string({
      description: 'Match by `AXValue` using an exact match.',
    }),
    activate: Flags.string({
      description:
        'How to activate the element: `touch` (default) scrolls it into view and taps with a real touch; `ax` performs an accessibility press without touch events.',
      options: ['touch', 'ax'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosTapElement);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('ios tap-element only supports iOS instances');
      }

      const selector: Record<string, string> = {};
      if (flags['ax-unique-id']) selector.AXUniqueId = flags['ax-unique-id'];
      if (flags['ax-label']) selector.AXLabel = flags['ax-label'];
      if (flags['ax-label-contains']) selector.AXLabelContains = flags['ax-label-contains'];
      if (flags.type) selector.type = flags.type;
      if (flags.title) selector.title = flags.title;
      if (flags['title-contains']) selector.titleContains = flags['title-contains'];
      if (flags['ax-value']) selector.AXValue = flags['ax-value'];

      if (Object.keys(selector).length === 0) {
        this.error(
          'Provide at least one iOS selector flag such as --ax-label, --ax-unique-id, --type, or --title.',
        );
      }

      const options: Ios.TapElementOptions | undefined =
        flags.activate ? { activate: flags.activate as Ios.TapElementActivation } : undefined;
      if (hasActiveSession(id)) {
        // The daemon-held request uses the SDK's 90s tapElement budget
        // (off-screen scroll scans); the IPC socket must not give up first.
        const result = await sendSessionCommand(
          id,
          'tap-element',
          [selector, options],
          Ios.TAP_ELEMENT_TIMEOUT_MS + 15_000,
        );
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
        return;
      }

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const result = await client.tapElement(selector, options);
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
      } finally {
        disconnect();
      }
    });
  }
}
