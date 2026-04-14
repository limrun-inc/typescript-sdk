import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class XcodeList extends BaseCommand {
  static summary = 'List Xcode instances or get a specific one';
  static aliases = ['get xcode'];
  static examples = ['<%= config.bin %> xcode list', '<%= config.bin %> xcode list --id <ID>'];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Instance ID to get' }),
    state: Flags.string({ description: 'Filter by state (unknown, creating, ready, terminated)' }),
    'label-selector': Flags.string({ description: 'Filter by labels (e.g. env=prod,region=us-west)' }),
    all: Flags.boolean({ description: 'Show all states, not just ready', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (flags.id) {
        const instance = await this.client.xcodeInstances.get(flags.id);
        if (flags.json) {
          this.outputJson(instance);
        } else {
          this.outputTable(
            ['ID', 'Name', 'Region', 'State'],
            [
              [
                instance.metadata.id,
                instance.metadata.displayName || '',
                instance.spec.region,
                instance.status.state,
              ],
            ],
          );
        }
        return;
      }

      const params: Record<string, unknown> = {};
      if (flags.state) {
        params.state = flags.state;
      } else if (!flags.all) {
        params.state = 'ready';
      }
      if (flags['label-selector']) params.labelSelector = flags['label-selector'];

      const instances = await this.client.xcodeInstances.list(params as any);
      const items = instances.items ?? instances.getPaginatedItems();
      const rows = items.map((i: any) => [
        i.metadata.id,
        i.metadata.displayName || '',
        i.spec.region,
        i.status.state,
      ]);

      if (flags.json) {
        this.outputJson(items);
      } else {
        this.outputTable(['ID', 'Name', 'Region', 'State'], rows);
      }
    });
  }
}
