import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class IosAppLogs extends BaseCommand {
  static summary = 'List persisted app log captures of an iOS instance';
  static description =
    'List app log captures persisted with the persist option (e.g. `lim ios create --app-logs <bundleId>`). Each entry is a timestamped JSONL file with a short-lived download URL in `--json` output. For live tailing of a running instance use `lim ios app-log`.';
  static examples = [
    '<%= config.bin %> ios app-logs',
    '<%= config.bin %> ios app-logs --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to list. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosAppLogs);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveIosInstance(flags.id).id;
      const artifacts = await this.client.iosInstances.listAppLogs(id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
