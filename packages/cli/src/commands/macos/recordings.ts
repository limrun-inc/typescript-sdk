import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class MacosRecordings extends BaseCommand {
  static summary = 'List persisted screen recordings of a macOS instance';
  static description =
    'List screen recordings persisted with `lim macos record start --persist` or `lim macos create --record`. Each entry carries a short-lived download URL in `--json` output. Recordings outlive the instance until their TTL expires.';
  static examples = [
    '<%= config.bin %> macos recordings',
    '<%= config.bin %> macos recordings --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosRecordings);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const artifacts = await this.client.macosInstances.listRecordings(this.resolveMacosTarget(flags.id).id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
