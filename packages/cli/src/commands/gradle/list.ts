import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class GradleList extends BaseCommand {
  static summary = 'List gradle instances';
  static description =
    'List gradle build sandbox instances in your account. By default only ready sandboxes are shown; use `--all` or `--state` to inspect other lifecycle states.';
  static examples = [
    '<%= config.bin %> gradle list',
    '<%= config.bin %> gradle list --all',
    '<%= config.bin %> gradle list --label-selector env=prod',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    state: Flags.string({
      description: 'Lifecycle state to filter by: unknown, creating, assigned, ready, or terminated',
    }),
    'label-selector': Flags.string({
      description: 'Comma-separated label filters, for example env=prod,team=mobile',
    }),
    all: Flags.boolean({
      description: 'Show all states instead of defaulting to ready instances only',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GradleList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const params: { state?: string; labelSelector?: string } = {};
      if (flags.state) {
        params.state = flags.state;
      } else if (!flags.all) {
        params.state = 'ready';
      }
      if (flags['label-selector']) params.labelSelector = flags['label-selector'];

      const instances = await this.client.gradleInstances.list(params);
      const items = instances.items ?? instances.getPaginatedItems();
      const rows = items.map((i) => [
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
