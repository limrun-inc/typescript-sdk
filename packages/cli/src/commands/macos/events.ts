import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class MacosEvents extends BaseCommand {
  static summary = 'List persisted event log captures of a macOS instance';
  static description =
    'List event logs persisted with `lim macos create --events`: the clicks, scrolls and keys sent to the screen, with typing counted, never recorded. Each entry carries a short-lived download URL in `--json` output.';
  static examples = [
    '<%= config.bin %> macos events',
    '<%= config.bin %> macos events --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosEvents);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const artifacts = await this.client.macosInstances.listEvents(this.resolveMacosTarget(flags.id).id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
