import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AccessTokenCreate extends BaseCommand {
  static summary = 'Create a temporary access token';
  static description =
    'Delegate permissions held by your API key or login. Save the returned ID to revoke the token. ' +
    'With --quiet, print only the token; with --json, include its ID, permissions, and expiry. ' +
    'Permission reference: https://docs.limrun.com/docs/reference/permissions';
  static examples = [
    '<%= config.bin %> access-token create --permission "ios:<instance-id>:stream" --ttl-seconds 900 --json',
    '<%= config.bin %> access-token create --permission "android:<instance-id>:all" --ttl-seconds 900 --json',
    '<%= config.bin %> access-token create --permission "asset:name/releases/app.ipa:read" --permission "device:*:install"',
  ];

  static flags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    json: BaseCommand.baseFlags.json,
    quiet: BaseCommand.baseFlags.quiet,
    permission: Flags.string({
      description: 'Permission in resource:target:action form. Repeat for each permission.',
      required: true,
      multiple: true,
    }),
    'ttl-seconds': Flags.integer({
      description: 'Token lifetime in seconds, from 1 to 14400. Defaults to 3600.',
      min: 1,
      max: 14400,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AccessTokenCreate);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const token = await this.client.accessTokens.create({
        permissions: flags.permission,
        ...(flags['ttl-seconds'] === undefined ? {} : { ttlSeconds: flags['ttl-seconds'] }),
      });
      if (flags.json) {
        this.outputJson(token);
      } else if (flags.quiet) {
        this.output(token.token);
      } else {
        this.output(
          `ID: ${token.id}\nExpires: ${token.expiresAt}\nPermissions: ${token.permissions.join(
            ', ',
          )}\nToken: ${token.token}`,
        );
      }
    });
  }
}
