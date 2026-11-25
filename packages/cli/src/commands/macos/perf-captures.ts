import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class MacosPerfCaptures extends BaseCommand {
  static summary = 'List persisted performance captures of a macOS instance';
  static description =
    "List performance captures persisted with `lim macos create --perf`: each running app's CPU, memory, threads and disk, sampled once a second. Each entry carries a short-lived download URL in `--json` output.";
  static examples = [
    '<%= config.bin %> macos perf-captures',
    '<%= config.bin %> macos perf-captures --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosPerfCaptures);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const artifacts = await this.client.macosInstances.listPerformanceCaptures(
        this.resolveMacosTarget(flags.id).id,
      );
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
