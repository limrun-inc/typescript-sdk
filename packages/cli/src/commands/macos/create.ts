import { Flags } from '@oclif/core';
import { type MacosInstanceCreateParams } from '@limrun/api/resources/macos-instances';
import { BaseCommand } from '../../base-command';
import { createdInstanceOutput } from '../../lib/create-output';
import { delegatedPermissionsFromFlags } from '../../lib/delegated-permissions';
import { registerCreatedInstance } from '../../lib/config';
import { parseLabels } from '../../lib/formatting';

export default class MacosCreate extends BaseCommand {
  static summary = 'Create a new macOS instance';
  static description =
    'Create a macOS virtual machine in the cloud and wait until it is ready. Open it in the console to see and control its desktop.';

  static examples = [
    '<%= config.bin %> macos create',
    '<%= config.bin %> macos create --jurisdiction eu',
    '<%= config.bin %> macos create --label env=dev --display-name review-mac --inactivity-timeout 30m',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.permissionFlags,
    'display-name': Flags.string({
      description: 'Human-friendly display name shown in listings and the console',
    }),
    jurisdiction: Flags.string({
      description:
        'Jurisdiction the instance must be created in. Creation fails when no region in the jurisdiction has capacity.',
      options: ['us', 'eu', 'as'],
    }),
    'hard-timeout': Flags.string({
      description: "Hard timeout (e.g. 1m, 10m, 3h). Default: the organization's macOS default",
    }),
    'inactivity-timeout': Flags.string({
      description: "Inactivity timeout (e.g. 1m, 10m, 3h). Default: the organization's macOS default",
    }),
    label: Flags.string({
      description: 'Metadata label in key=value format. Repeat to attach multiple labels.',
      multiple: true,
    }),
    'reuse-if-exists': Flags.boolean({
      description: 'Reuse an existing instance with matching labels; its permissions remain unchanged',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosCreate);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const labels = parseLabels(flags.label);
      const metadata = {
        ...(flags['display-name'] && { displayName: flags['display-name'] }),
        ...(labels && { labels }),
      };
      const delegatedPermissions = delegatedPermissionsFromFlags(this.parsedFlags ?? {});
      const params: MacosInstanceCreateParams = {
        wait: true,
        reuseIfExists: flags['reuse-if-exists'] || undefined,
        spec: {
          role: { permissions: delegatedPermissions ?? [] },
          ...(flags.jurisdiction && { jurisdiction: flags.jurisdiction as 'us' | 'eu' | 'as' }),
          ...(flags['hard-timeout'] && { hardTimeout: flags['hard-timeout'] }),
          ...(flags['inactivity-timeout'] && { inactivityTimeout: flags['inactivity-timeout'] }),
        },
        ...(Object.keys(metadata).length > 0 && { metadata }),
      };
      const instance = await this.client.macosInstances.create(params);
      const consoleUrl = this.consoleStreamUrl(instance.metadata.id);
      registerCreatedInstance(instance);

      if (flags.json) {
        this.outputJson(createdInstanceOutput(instance, consoleUrl));
        return;
      }
      this.output(`Created macOS instance: ${instance.metadata.id}`);
      this.output(`Console URL: ${consoleUrl}`);
      this.output(`Region: ${instance.spec.region}`);
      this.output(`Delete with: lim macos delete ${instance.metadata.id}`);
    });
  }
}
