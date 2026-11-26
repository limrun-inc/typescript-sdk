import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parsePointFlag } from '../../lib/parse-point';

export default class MacosDrag extends BaseCommand {
  static summary = 'Drag with the mouse on a macOS instance';
  static description =
    'Press the left button at one point, move to another, and release: for sliders, selecting text and moving windows. Points are "x,y" in screenshot pixels.';
  static aliases = ['macos:swipe'];
  static examples = [
    '<%= config.bin %> macos drag --from 200,300 --to 600,300',
    '<%= config.bin %> macos swipe --from 640,600 --to 640,200 --duration 800',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    from: Flags.string({ description: 'Start point, "x,y".', required: true }),
    to: Flags.string({ description: 'End point, "x,y".', required: true }),
    duration: Flags.integer({ description: 'Milliseconds the move takes.', default: 300, min: 0, max: 5000 }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosDrag);
    this.setParsedFlags(flags);
    const from = parsePointFlag(flags.from, '--from');
    const to = parsePointFlag(flags.to, '--to');
    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      await client.drag({ x: from[0], y: from[1] }, { x: to[0], y: to[1] }, { durationMs: flags.duration });
      this.outputResult(
        { ok: true, instanceId: id, from, to, durationMs: flags.duration },
        `Dragged from (${from.join(', ')}) to (${to.join(', ')})`,
      );
    });
  }
}
