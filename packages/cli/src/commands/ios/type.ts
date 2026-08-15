import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosType extends BaseCommand {
  static summary = 'Type text into the focused iOS input field';
  static description =
    'Type text into the currently focused input field as real key events, so the app sees genuine keystrokes ' +
    'and text delegates fire. Fails when no field is focused. For fast text entry without key events, use ' +
    '`ios set-text`. Use `--enter` to submit the field after typing. Use `--no-require-focus` to type blind ' +
    'when the field was focused by other means (e.g. a coordinate tap) and the accessibility focus scan is unreliable.';
  static examples = [
    '<%= config.bin %> ios type "Hello World"',
    '<%= config.bin %> ios type "Hello World" --id <instance-ID>',
    '<%= config.bin %> ios type "search query" --enter',
    '<%= config.bin %> ios type "Hello" --no-require-focus',
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
    'require-focus': Flags.boolean({
      description:
        'Require a focused input field before typing (`--no-require-focus` types blind for fields focused by other means).',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosType);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;

      // The SDK sends requireFocus on the wire only when false, so the
      // default flag value keeps legacy payloads byte-identical.
      const options = { requireFocus: flags['require-focus'] };
      if (await ensureDaemonSession(resolvedInstance)) {
        await sendSessionCommand(id, 'type', [args.text, flags.enter, options]);
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          await client.typeText(args.text, flags.enter, options);
        } finally {
          disconnect();
        }
      }
      this.log('Text typed');
    });
  }
}
