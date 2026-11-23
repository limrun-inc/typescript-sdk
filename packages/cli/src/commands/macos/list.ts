import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class MacosList extends BaseCommand {
  static summary = 'List macOS instances';
  static description =
    'List macOS instances in your account. By default only ready instances are shown; use `--all` or `--state` to inspect other lifecycle states.';
  static examples = [
    '<%= config.bin %> macos list',
    '<%= config.bin %> macos list --all',
    '<%= config.bin %> macos list --label-selector env=dev',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    state: Flags.string({
      description:
        'Lifecycle states to filter by, comma-separated: unknown, creating, assigned, ready, terminating, or terminated',
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
    const { flags } = await this.parse(MacosList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const params: { state?: string; labelSelector?: string } = {};
      if (flags.state) {
        params.state = flags.state;
      } else if (!flags.all) {
        params.state = 'ready';
      }
      if (flags['label-selector']) params.labelSelector = flags['label-selector'];

      const instances = await this.client.macosInstances.list(params);
      const items = instances.items ?? instances.getPaginatedItems();
      if (flags.json) {
        this.outputJson(items);
        return;
      }
      this.outputTable(
        ['ID', 'Name', 'Region', 'State'],
        items.map((i) => [i.metadata.id, i.metadata.displayName || '', i.spec.region, i.status.state]),
      );
    });
  }
}
