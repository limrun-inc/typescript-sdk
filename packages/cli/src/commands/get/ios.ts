import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class GetIos extends BaseCommand {
  static summary = 'List iOS instances or get a specific one';
  static aliases = ['get i'];
  static examples = ['<%= config.bin %> get ios', '<%= config.bin %> get ios <ID>'];

  static args = {
    id: Args.string({ description: 'Instance ID to get', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    state: Flags.string({ description: 'Filter by state (unknown, creating, ready, terminated)' }),
    region: Flags.string({ description: 'Filter by region' }),
    'label-selector': Flags.string({ description: 'Filter by labels (e.g. env=prod,region=us-west)' }),
    all: Flags.boolean({ description: 'Show all states, not just ready', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GetIos);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (args.id) {
        const instance = await this.client.iosInstances.get(args.id);
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
      if (flags.region) params.region = flags.region;
      if (flags['label-selector']) params.labelSelector = flags['label-selector'];

      const instances = await this.client.iosInstances.list(params as any);
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
