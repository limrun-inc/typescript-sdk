import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class IosPerfCaptures extends BaseCommand {
  static summary = 'List saved performance captures of an iOS instance';
  static description =
    'List performance captures saved by `lim ios create --perf` or the SDK. Each entry is a JSONL file with one CPU and memory sample per running app per second, with a short-lived download URL in `--json` output.';
  static examples = [
    '<%= config.bin %> ios perf-captures',
    '<%= config.bin %> ios perf-captures --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to list. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosPerfCaptures);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveIosInstance(flags.id).id;
      const artifacts = await this.client.iosInstances.listPerformanceCaptures(id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
