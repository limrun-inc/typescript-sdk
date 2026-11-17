import { Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';
import { fetchWhoAmI } from '../lib/backend';

export default class Whoami extends BaseCommand {
  static summary = 'Show your authenticated identity';
  static description = 'Ask Limrun which identity and organization your credential represents.';
  static examples = ['<%= config.bin %> whoami', '<%= config.bin %> whoami --permissions'];
  static flags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    json: BaseCommand.baseFlags.json,
    permissions: Flags.boolean({
      description: 'Include the permissions reported by Limrun.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Whoami);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const identity = await fetchWhoAmI(this.client);
      const organization = identity.organization ?? identity.user?.defaultOrganization;
      const memberships = identity.memberships?.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role,
        ...(flags.permissions ? { permissions: membership.permissions ?? membership.scopes } : {}),
      }));
      const permissions = identity.permissions ?? identity.scopes;
      if (flags.json) {
        this.outputJson({
          type: identity.type,
          user: identity.user,
          organization,
          memberships,
          ...(flags.permissions ? { permissions } : {}),
        });
        return;
      }
      this.output(`Type: ${identity.type}`);
      if (identity.user) this.output(`User: ${identity.user.email ?? identity.user.id}`);
      if (organization) {
        this.output(
          `Organization: ${organization.id}${
            organization.displayName ? ` (${organization.displayName})` : ''
          }`,
        );
      }
      if (flags.permissions && permissions !== undefined) {
        this.output(
          `Permissions:\n${
            permissions.length ? permissions.map((permission) => `  ${permission}`).join('\n') : '  None'
          }`,
        );
      }
      for (const membership of memberships ?? []) {
        this.output(`Membership: ${membership.organizationId} (${membership.role})`);
        if (flags.permissions && membership.permissions !== undefined) {
          this.output(
            `Permissions:\n${
              membership.permissions.length ?
                membership.permissions.map((permission) => `  ${permission}`).join('\n')
              : '  None'
            }`,
          );
        }
      }
    });
  }
}
