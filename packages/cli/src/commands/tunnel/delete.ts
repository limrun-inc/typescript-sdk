import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { deleteTunnel, findTunnel, tunnelOrganization } from '../../lib/backend';

export default class TunnelDelete extends BaseCommand {
  static summary = 'Delete a persistent tunnel';
  static description =
    'Delete a persistent tunnel. Its connector exits, its token stops working, and instances that name it ' +
    "lose access to its network. Needs an admin's API key or login.";
  static examples = ['<%= config.bin %> tunnel delete staging'];

  static args = {
    name: Args.string({ description: 'Name of the tunnel to delete.', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TunnelDelete);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const organizationId = await tunnelOrganization(this.client);
      const tunnel = await findTunnel(this.client, organizationId, args.name);
      if (!tunnel) {
        this.error(`Tunnel ${args.name} does not exist.`);
      }
      await deleteTunnel(this.client, organizationId, tunnel.id);
      this.output(`Deleted tunnel ${args.name}. Its connector exits and its token stops working.`);
    });
  }
}
