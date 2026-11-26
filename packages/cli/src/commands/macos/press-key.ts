import { Args, Flags } from '@oclif/core';
import type { MacosModifier } from '@limrun/api/resources/macos-instances-helpers';
import { BaseCommand } from '../../base-command';

export default class MacosPressKey extends BaseCommand {
  static summary = 'Press a key on a macOS instance';
  static description =
    'Press one key, optionally with modifiers held. Keys: a letter or digit, enter, tab, space, backspace, forwarddelete, escape, up, down, left, right, home, end, pageup, pagedown, f1-f12.';
  static examples = [
    '<%= config.bin %> macos press-key enter',
    '<%= config.bin %> macos press-key space --modifier command',
    '<%= config.bin %> macos press-key q --modifier command',
  ];

  static args = {
    key: Args.string({ description: 'Key to press', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    modifier: Flags.string({
      description: 'Modifier to hold, repeatable.',
      options: ['shift', 'control', 'option', 'command'],
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosPressKey);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      const modifiers = (flags.modifier ?? []) as MacosModifier[];
      await client.pressKey(args.key, modifiers);
      const chord = [...modifiers, args.key].join('+');
      this.outputResult({ ok: true, instanceId: id, key: args.key, modifiers }, `Pressed ${chord}`);
    });
  }
}
