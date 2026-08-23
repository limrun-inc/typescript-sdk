import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class AndroidAppLogs extends BaseCommand {
  static summary = 'List persisted app log captures of an Android instance';
  static description =
    'List app log captures persisted with the persist option (e.g. `lim android create --app-logs <packageName>`). Each entry is a timestamped JSONL file with a short-lived download URL in `--json` output.';
  static examples = [
    '<%= config.bin %> android app-logs',
    '<%= config.bin %> android app-logs --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to list. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidAppLogs);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveAndroidInstance(flags.id).id;
      const artifacts = await this.client.androidInstances.listAppLogs(id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
