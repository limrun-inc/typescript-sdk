import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AndroidList extends BaseCommand {
  static summary = 'List Android instances';
  static description =
    'List Android instances in your account. By default only ready instances are shown; use `--all` or `--state` to inspect other lifecycle states.';
  static examples = [
    '<%= config.bin %> android list',
    '<%= config.bin %> android list --all',
    '<%= config.bin %> android list --region us-west --label-selector env=prod',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    state: Flags.string({
      description: 'Lifecycle state to filter by: unknown, creating, ready, or terminated',
    }),
    region: Flags.string({ description: 'Region to filter by, such as us-west' }),
    'label-selector': Flags.string({
      description: 'Comma-separated label filters, for example env=prod,team=mobile',
    }),
    all: Flags.boolean({
      description: 'Show all states instead of defaulting to ready instances only',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const params: Record<string, unknown> = {};
      if (flags.state) {
        params.state = flags.state;
      } else if (!flags.all) {
        params.state = 'ready';
      }
      if (flags.region) params.region = flags.region;
      if (flags['label-selector']) params.labelSelector = flags['label-selector'];

      const instances = await this.client.androidInstances.list(params as any);
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
