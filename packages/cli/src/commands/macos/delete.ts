import { NotFoundError } from '@limrun/api';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { clearLastInstanceId } from '../../lib/config';
import { waitSnapshotFlag } from '../../lib/cache-flags';
import { waitMacosSnapshotSave } from '../../lib/macos-snapshot';

export default class MacosDelete extends BaseCommand {
  static summary = 'Delete a macOS instance';
  static description = 'Delete a macOS instance by ID. Everything on its disk is discarded.';
  static examples = [
    '<%= config.bin %> macos delete',
    '<%= config.bin %> macos delete <ID>',
    '<%= config.bin %> macos delete --wait-snapshot',
  ];

  static args = {
    id: Args.string({
      description: 'macOS instance ID to delete. Defaults to the last created macOS instance.',
      required: false,
    }),
  };

  static flags = { ...BaseCommand.baseFlags, 'wait-snapshot': waitSnapshotFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveMacosTarget(args.id).id;
      try {
        await this.client.macosInstances.delete(id);
      } catch (err) {
        if (!(err instanceof NotFoundError)) {
          throw err;
        }
      }
      clearLastInstanceId(id);
      // The instance is held until its snapshot is saved, so the save is reported first.
      if (
        flags['wait-snapshot'] &&
        !(await waitMacosSnapshotSave(this.client, id, (line) => this.info(line)))
      ) {
        this.error('The snapshot was not published.');
      }
      this.outputResult({ ok: true, id }, `Deleted macOS instance: ${id}`);
    });
  }
}
