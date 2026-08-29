import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class AndroidRecordings extends BaseCommand {
  static summary = 'List persisted session recordings of an Android instance';
  static description =
    'List video recordings persisted with the persist option (e.g. `lim android create --record`). Each entry carries a short-lived download URL in `--json` output. Recordings outlive the instance until their TTL expires.';
  static examples = [
    '<%= config.bin %> android recordings',
    '<%= config.bin %> android recordings --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to list. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidRecordings);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveAndroidInstance(flags.id).id;
      const artifacts = await this.client.androidInstances.listRecordings(id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
