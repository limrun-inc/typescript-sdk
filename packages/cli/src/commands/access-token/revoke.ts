import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AccessTokenRevoke extends BaseCommand {
  static summary = 'Revoke an access token by its ID';
  static description =
    'Use the ID returned by access-token create, not the token value. Repeating revocation is safe. ' +
    'Revocation affects API services that check it; instance endpoints continue accepting the token ' +
    'until expiry or instance termination. Existing connections are not closed.';
  static examples = ['<%= config.bin %> access-token revoke <token-id>'];
  static args = {
    id: Args.string({ description: 'ID returned when the access token was created.', required: true }),
  };
  static flags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    json: BaseCommand.baseFlags.json,
    quiet: BaseCommand.baseFlags.quiet,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AccessTokenRevoke);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      await this.client.accessTokens.revoke(args.id);
      this.outputResult({ ok: true, id: args.id }, `Revoked access token ${args.id}.`);
    });
  }
}
