import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class MacosType extends BaseCommand {
  static summary = 'Type text on a macOS instance';
  static description =
    'Type text into whatever has keyboard focus, with key presses on the US layout. Click the field first with lim macos tap.';
  static examples = [
    '<%= config.bin %> macos type "hello world"',
    '<%= config.bin %> macos type "ls" --enter',
  ];

  static args = {
    text: Args.string({ description: 'Text to type', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    enter: Flags.boolean({ description: 'Press Return after the text.', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosType);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      await client.typeText(flags.enter ? `${args.text}\n` : args.text);
      this.outputResult(
        { ok: true, instanceId: id, characters: args.text.length, enter: flags.enter },
        `Typed ${args.text.length} characters`,
      );
    });
  }
}
