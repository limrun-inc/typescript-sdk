import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class IosEvents extends BaseCommand {
  static summary = 'List persisted event log captures of an iOS instance';
  static description =
    'List event log captures persisted with the persist option (e.g. `lim ios create --events`). Each entry is a timestamped JSONL file of coalesced user actions (taps, drags, commands) with a short-lived download URL in `--json` output.';
  static examples = [
    '<%= config.bin %> ios events',
    '<%= config.bin %> ios events --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to list. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosEvents);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveIosInstance(flags.id).id;
      const artifacts = await this.client.iosInstances.listEvents(id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
