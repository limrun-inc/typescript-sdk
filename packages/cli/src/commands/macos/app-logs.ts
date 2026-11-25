import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class MacosAppLogs extends BaseCommand {
  static summary = 'List persisted app log captures of a macOS instance';
  static description =
    "List app log captures persisted with `lim macos create --app-logs`: one JSON object per line of the app's log. Each entry carries a short-lived download URL in `--json` output. Captures outlive the instance until their TTL expires.";
  static examples = [
    '<%= config.bin %> macos app-logs',
    '<%= config.bin %> macos app-logs --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosAppLogs);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const artifacts = await this.client.macosInstances.listAppLogs(this.resolveMacosTarget(flags.id).id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
