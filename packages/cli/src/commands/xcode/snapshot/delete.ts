import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { whoAmI } from '../../../lib/backend';
import { snapshotResource } from '../../../lib/snapshots';

export default class XcodeSnapshotDelete extends BaseCommand {
  static summary = 'Delete Xcode snapshots';
  static description =
    'Permanently delete the saved archive and its index entry. Running instances can save it again. Stop instances saving this key first if it must remain empty. Also available as snapshot flush.';
  static aliases = ['xcode:snapshot:flush'];
  static examples = ['<%= config.bin %> xcode snapshot delete myapp-main'];

  static args = { key: Args.string({ required: true, description: 'Exact snapshot key.' }) };

  static flags = {
    ...BaseCommand.baseFlags,
    organization: Flags.string({
      description: 'Organization ID. Defaults to the API key or login organization.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeSnapshotDelete);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const organizationId = flags.organization ?? (await whoAmI(this.client));
      await snapshotResource(this.client, 'xcode', organizationId).delete(args.key);
      this.outputResult(
        { ok: true, key: args.key },
        `Deleted snapshot ${args.key}. Running instances can save this key again.`,
      );
    });
  }
}
