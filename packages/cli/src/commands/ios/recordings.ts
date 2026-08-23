import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { sessionArtifactTable } from '../../lib/session-artifacts';

export default class IosRecordings extends BaseCommand {
  static summary = 'List persisted session recordings of an iOS instance';
  static description =
    'List video recordings persisted with the persist option (e.g. `lim ios create --record`). Each entry carries a short-lived download URL in `--json` output. Recordings outlive the instance until their TTL expires.';
  static examples = [
    '<%= config.bin %> ios recordings',
    '<%= config.bin %> ios recordings --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to list. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosRecordings);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveIosInstance(flags.id).id;
      const artifacts = await this.client.iosInstances.listRecordings(id);
      if (flags.json) {
        this.outputJson(artifacts);
        return;
      }
      const { headers, rows } = sessionArtifactTable(artifacts);
      this.outputTable(headers, rows);
    });
  }
}
