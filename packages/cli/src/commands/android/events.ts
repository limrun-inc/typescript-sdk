import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class AndroidEvents extends BaseCommand {
  static summary = 'List persisted event log captures of an Android instance';
  static description =
    'List event log captures persisted with the persist option (e.g. `lim android create --events`). Each entry is a timestamped JSONL file of coalesced user actions (taps, drags, commands) with a short-lived download URL in `--json` output.';
  static examples = [
    '<%= config.bin %> android events',
    '<%= config.bin %> android events --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to list. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidEvents);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveAndroidInstance(flags.id).id;
      const artifacts = await this.client.androidInstances.listEvents(id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
