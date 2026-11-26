import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class MacosTap extends BaseCommand {
  static summary = 'Click at a point on a macOS instance';
  static description =
    'Move the pointer to a point and click. Coordinates are pixels of lim macos screenshot, from the top-left corner.';
  static examples = ['<%= config.bin %> macos tap 640 360', '<%= config.bin %> macos tap 640 360 --right'];

  static args = {
    x: Args.integer({ description: 'X coordinate in screenshot pixels', required: true }),
    y: Args.integer({ description: 'Y coordinate in screenshot pixels', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    right: Flags.boolean({ description: 'Click with the right button, for context menus.', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosTap);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      await client.tap({ x: args.x, y: args.y }, flags.right ? { button: 'right' } : undefined);
      this.outputResult(
        { ok: true, instanceId: id, x: args.x, y: args.y, button: flags.right ? 'right' : 'left' },
        `Clicked at (${args.x}, ${args.y})`,
      );
    });
  }
}
