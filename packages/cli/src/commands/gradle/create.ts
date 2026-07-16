import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseLabels } from '../../lib/formatting';
import { registerCreatedInstance } from '../../lib/config';
import { type GradleInstanceCreateParams } from '@limrun/api/resources/gradle-instances';

export default class GradleCreate extends BaseCommand {
  static summary = 'Create a new gradle instance';
  static description = 'Create a new cloud gradle build sandbox for remote Android builds.';

  static examples = [
    '<%= config.bin %> gradle create',
    '<%= config.bin %> gradle create --region eu',
    '<%= config.bin %> gradle create --label env=dev --display-name ci-builder',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'display-name': Flags.string({
      description: 'Human-friendly display name shown in listings and the console',
    }),
    region: Flags.string({ description: 'Region where the sandbox should be created, such as us-west' }),
    'hard-timeout': Flags.string({ description: 'Hard timeout (e.g. 1m, 10m, 3h). Default: no timeout' }),
    'inactivity-timeout': Flags.string({
      description: 'Inactivity timeout (e.g. 1m, 10m, 3h). Default is 5m.',
    }),
    label: Flags.string({
      description: 'Metadata label in key=value format. Repeat to attach multiple labels.',
      multiple: true,
    }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse an existing matching instance instead of creating a new one',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GradleCreate);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const labels = parseLabels(flags.label);
      const metadata = {
        ...(flags['display-name'] && { displayName: flags['display-name'] }),
        ...(labels && { labels }),
      };
      const params: GradleInstanceCreateParams = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: {
          ...(flags.region && { region: flags.region }),
          ...(flags['hard-timeout'] && { hardTimeout: flags['hard-timeout'] }),
          ...(flags['inactivity-timeout'] && { inactivityTimeout: flags['inactivity-timeout'] }),
        },
        ...(Object.keys(metadata).length > 0 && { metadata }),
      };
      const instance = await this.client.gradleInstances.create(params);
      registerCreatedInstance(instance);

      if (flags.json) {
        this.outputJson(instance);
        return;
      }
      this.output(`Created gradle instance: ${instance.metadata.id}`);
      this.output(`Region: ${instance.spec.region}`);
      this.output(`Build with: lim gradle build --id ${instance.metadata.id}`);
    });
  }
}
