import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';

const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function revocationId(input: string): string {
  if (TOKEN_ID.test(input)) return input;
  if (!input.startsWith('lim_st_')) {
    throw new Error('Expected an access-token ID (UUID) or a lim_st_ access token.');
  }

  let claims: unknown;
  try {
    const jwt = input.slice('lim_st_'.length);
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
      throw new Error('Invalid JWT structure');
    }
    claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed access token; expected a lim_st_ JWT.');
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw new Error('Malformed access token; expected a JWT claims object.');
  }
  const { jti } = claims as { jti?: unknown };
  if (jti === undefined || jti === '') {
    throw new Error('This access token has no jti and cannot be revoked by ID.');
  }
  if (typeof jti !== 'string' || !TOKEN_ID.test(jti)) {
    throw new Error('Access token has an invalid jti; expected a UUID.');
  }
  // Decode only to select an ID; the API key or login authorizes revocation.
  return jti;
}

export default class AccessTokenRevoke extends BaseCommand {
  static summary = 'Revoke an access token by its ID or token value';
  static description =
    'Pass the ID returned by access-token create or the lim_st_ token itself. ' +
    'For a token, the CLI extracts its jti claim; tokens without a jti cannot be revoked. ' +
    'Your API key or login still authorizes the request. Repeating revocation is safe. ' +
    'Revocation affects API services that check it; instance endpoints continue accepting the token ' +
    'until expiry or instance termination. Existing connections are not closed.';
  static examples = [
    '<%= config.bin %> access-token revoke <token-id>',
    '<%= config.bin %> access-token revoke "$ACCESS_TOKEN"',
  ];
  static args = {
    'id-or-token': Args.string({ description: 'Access-token ID or lim_st_ token value.', required: true }),
  };
  static flags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    json: BaseCommand.baseFlags.json,
    quiet: BaseCommand.baseFlags.quiet,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AccessTokenRevoke);
    this.setParsedFlags(flags);
    const id = revocationId(args['id-or-token']);
    await this.withAuth(async () => {
      await this.client.accessTokens.revoke(id);
      this.outputResult({ ok: true, id }, `Revoked access token ${id}.`);
    });
  }
}
