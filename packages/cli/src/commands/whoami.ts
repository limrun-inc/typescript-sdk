import { BaseCommand } from '../base-command';
import { fetchWhoAmI } from '../lib/backend';

export default class Whoami extends BaseCommand {
  static summary = 'Show your authenticated identity and permissions as JSON';
  static description = 'Ask Limrun which identity, organization, and permissions your credential represents.';
  static examples = ['<%= config.bin %> whoami'];
  static flags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    json: { ...BaseCommand.baseFlags.json, default: true },
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Whoami);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const identity = await fetchWhoAmI(this.client, 'Failed to look up your identity');
      const organization = identity.organization ?? identity.user?.defaultOrganization;
      this.outputJson({
        type: identity.type,
        ...(identity.user ? { user: { id: identity.user.id, email: identity.user.email } } : {}),
        ...(organization ?
          { organization: { id: organization.id, displayName: organization.displayName } }
        : {}),
        ...(identity.memberships ?
          {
            memberships: identity.memberships.map((membership) => ({
              organizationId: membership.organizationId,
              role: membership.role,
              permissions: membership.permissions ?? membership.scopes,
            })),
          }
        : {}),
        permissions: identity.permissions ?? identity.scopes,
      });
    });
  }
}
