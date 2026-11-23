import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { whoAmI } from '../../../lib/backend';
import { snapshotResource } from '../../../lib/snapshots';

export default class GradleSnapshotGet extends BaseCommand {
  static summary = 'Get Gradle snapshots';
  static description = 'Get saved Gradle snapshots for your organization.';
  static examples = ['<%= config.bin %> gradle snapshot get myapp-main'];

  static args = { key: Args.string({ required: true, description: 'Exact snapshot key.' }) };

  static flags = {
    ...BaseCommand.baseFlags,
    organization: Flags.string({
      description: 'Organization ID. Defaults to the API key or login organization.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleSnapshotGet);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const organizationId = flags.organization ?? (await whoAmI(this.client));
      const snapshot = await snapshotResource(this.client, 'gradle', organizationId).get(args.key);
      if (flags.json) {
        this.outputJson(snapshot);
        return;
      }
      this.outputTable(
        ['Field', 'Value'],
        Object.entries(snapshot).map(([field, value]) => [
          field,
          Array.isArray(value) ? value.join(', ') : String(value),
        ]),
      );
    });
  }
}
