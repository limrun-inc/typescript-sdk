import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { whoAmI } from '../../../lib/backend';
import { snapshotResource } from '../../../lib/snapshots';

export default class GradleSnapshotList extends BaseCommand {
  static summary = 'List Gradle snapshots';
  static description = 'List saved Gradle snapshots for your organization.';
  static examples = ['<%= config.bin %> gradle snapshot list --json'];

  static flags = {
    ...BaseCommand.baseFlags,
    organization: Flags.string({
      description: 'Organization ID. Defaults to the API key or login organization.',
    }),
    prefix: Flags.string({ description: 'Only keys starting with this literal prefix.' }),
    limit: Flags.integer({ description: 'Number of keys per page.', min: 1, max: 500, default: 25 }),
    offset: Flags.integer({ description: 'Number of keys to skip.', min: 0, max: 100000, default: 0 }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GradleSnapshotList);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const organizationId = flags.organization ?? (await whoAmI(this.client));
      const result = await snapshotResource(this.client, 'gradle', organizationId).list({
        prefix: flags.prefix,
        limit: flags.limit,
        offset: flags.offset,
      });
      if (flags.json) {
        this.outputJson(result);
        return;
      }
      this.outputTable(
        ['Key', 'Size (bytes)', 'Saved at'],
        result.snapshots.map((snapshot) => [
          snapshot.key,
          String(snapshot.archiveSizeBytes ?? 'Not saved'),
          snapshot.publishedAt ?? '',
        ]),
      );
      if (result.nextOffset !== undefined)
        this.info(`More snapshots: rerun with --offset ${result.nextOffset}.`);
    });
  }
}
