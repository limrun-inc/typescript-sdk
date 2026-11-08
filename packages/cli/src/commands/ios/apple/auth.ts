import { ensureAppStoreConnectApiKeySecret } from '@limrun/apple-auth';
import { BaseCommand } from '../../../base-command';
import { appleSessionFlags, withAppleSession } from '../../../lib/apple-session';

export default class AppleAuth extends BaseCommand {
  static summary = 'Sign in to Apple and save an App Store Connect key on this computer';
  static description =
    'Creates or reuses an ADMIN API key for cloud signing and uploads. Saves the key in ~/.lim/secrets; never saves your Apple password. Requires an interactive terminal and an Apple team administrator.';
  static flags = { ...BaseCommand.baseFlags, ...appleSessionFlags };
  async run(): Promise<void> {
    const { flags } = await this.parse(AppleAuth);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const { token } = await this.client.accessTokens.create({ scopes: ['applerelay:*:connect'] });
      await withAppleSession(token, flags, async ({ relay, team, store }) => {
        const result = await ensureAppStoreConnectApiKeySecret({
          relay,
          teamId: team!.teamId,
          providerId: team!.providerId,
          secretStore: store,
          nickname: 'Lim CLI',
          roles: ['ADMIN'],
        });
        this.outputResult(
          { teamId: team!.teamId, keyId: result.keyId, directory: store.directory },
          `Saved Apple credentials for team ${team!.teamId} in ${store.directory}.`,
        );
      });
    });
  }
}
