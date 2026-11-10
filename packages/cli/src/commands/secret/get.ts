import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { secretTarget } from '../../lib/secret-input';

export default class SecretGet extends BaseCommand {
  static summary = 'Get secret metadata, or list visible secrets';
  static description =
    'Returns metadata only. Use secret read to fetch a value. Listing is paginated using --limit and --offset.';
  static aliases = ['secret:list'];
  static args = { target: Args.string({ description: 'Secret ID or exact name. Omit to list.' }) };
  static flags = {
    ...BaseCommand.readOnlyFlags,
    limit: Flags.integer({ min: 1, max: 100, default: 50 }),
    offset: Flags.integer({ min: 0, max: 100000, default: 0 }),
    name: Flags.string({ description: 'Exact name filter for listing' }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(SecretGet);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const result =
        args.target ?
          await this.client.secrets.get(secretTarget(args.target))
        : await this.client.secrets.list({
            limit: flags.limit,
            offset: flags.offset,
            ...(flags.name ? { nameFilter: flags.name } : {}),
          });
      this.outputResult(result, JSON.stringify(result, null, 2));
    });
  }
}
