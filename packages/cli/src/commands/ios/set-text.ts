import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosSetText extends BaseCommand {
  static summary = 'Set text on an iOS element directly via accessibility';
  static description =
    'Set the value of a text field instantly through the accessibility API, without typing key events. ' +
    'Much faster than `ios type` for long strings, but key-event-driven text delegates do not fire; ' +
    'use `ios type` to simulate real typing. Target an element with selector flags, or `--focused` for ' +
    'whatever field currently has focus.';
  static examples = [
    '<%= config.bin %> ios set-text "user@example.com" --ax-unique-id email_field',
    '<%= config.bin %> ios set-text "long text to paste" --focused',
    '<%= config.bin %> ios set-text "Hello" --ax-label "Message" --id <instance-ID>',
  ];

  static args = {
    text: Args.string({ description: 'The text value to set', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    focused: Flags.boolean({
      description: 'Target the currently focused element instead of matching a selector.',
      default: false,
      exclusive: [
        'ax-unique-id',
        'ax-label',
        'ax-label-contains',
        'type',
        'title',
        'title-contains',
        'ax-value',
      ],
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
      description: 'Match by element type/role, such as `TextField`.',
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosSetText);
    this.setParsedFlags(flags);

    const selector: Record<string, string> = {};
    if (flags['ax-unique-id']) selector.AXUniqueId = flags['ax-unique-id'];
    if (flags['ax-label']) selector.AXLabel = flags['ax-label'];
    if (flags['ax-label-contains']) selector.AXLabelContains = flags['ax-label-contains'];
    if (flags.type) selector.type = flags.type;
    if (flags.title) selector.title = flags.title;
    if (flags['title-contains']) selector.titleContains = flags['title-contains'];
    if (flags['ax-value']) selector.AXValue = flags['ax-value'];

    if (!flags.focused && Object.keys(selector).length === 0) {
      this.error(
        'Provide a selector flag such as --ax-unique-id or --ax-label, or pass --focused to target the focused field.',
      );
    }
    const target = flags.focused ? undefined : selector;

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;

      if (hasActiveSession(id)) {
        const result = await sendSessionCommand(id, 'set-text', [args.text, target]);
        if (flags.json) this.outputJson(result);
        else this.log('Text set');
        return;
      }

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const result = await client.setElementValue(args.text, target);
        if (flags.json) this.outputJson(result);
        else this.log('Text set');
      } finally {
        disconnect();
      }
    });
  }
}
