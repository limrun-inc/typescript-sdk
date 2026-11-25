import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parsePointFlag } from '../../lib/parse-point';

export default class MacosScroll extends BaseCommand {
  static summary = 'Scroll on a macOS instance';
  static description =
    'Scroll the view under the pointer, like a mouse wheel: down reveals what is below. Pass --coordinate to move the pointer over the view first.';
  static examples = [
    '<%= config.bin %> macos scroll down',
    '<%= config.bin %> macos scroll up --amount 800 --coordinate 640,400',
  ];

  static args = {
    direction: Args.string({
      description: 'Scroll direction',
      required: true,
      options: ['up', 'down', 'left', 'right'],
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    amount: Flags.integer({ description: 'Distance in pixels.', default: 300, min: 1 }),
    coordinate: Flags.string({ description: 'Point to scroll over, as "x,y" in screenshot pixels.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosScroll);
    this.setParsedFlags(flags);
    const at = flags.coordinate ? parsePointFlag(flags.coordinate, '--coordinate') : undefined;
    const amount = flags.amount;
    const delta =
      args.direction === 'down' ? { dy: amount }
      : args.direction === 'up' ? { dy: -amount }
      : args.direction === 'right' ? { dx: amount }
      : { dx: -amount };
    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      await client.scroll({ ...delta, ...(at && { at: { x: at[0], y: at[1] } }) });
      this.outputResult(
        { ok: true, instanceId: id, direction: args.direction, amount },
        `Scrolled ${args.direction} ${amount}px`,
      );
    });
  }
}
