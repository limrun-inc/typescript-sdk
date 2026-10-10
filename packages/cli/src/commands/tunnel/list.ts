import { BaseCommand } from '../../base-command';
import { listTunnels, tunnelOrganization } from '../../lib/backend';

export default class TunnelList extends BaseCommand {
  static summary = 'List persistent tunnels';
  static description =
    "List the organization's persistent tunnels: whether a connector holds each, where it runs, its " +
    'selectors, when its token expires, and how many instances name it. --json includes tunnel IDs.';
  static examples = ['<%= config.bin %> tunnel list', '<%= config.bin %> tunnel list --json'];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(TunnelList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const organizationId = await tunnelOrganization(this.client);
      const tunnels = await listTunnels(this.client, organizationId);
      if (flags.json) {
        this.outputJson(tunnels);
        return;
      }
      this.outputTable(
        ['Name', 'ID', 'Status', 'Connector', 'Selectors', 'Token expires', 'Instances'],
        tunnels.map((tunnel) => [
          tunnel.ephemeral ? `${tunnel.name} (quick)` : tunnel.name,
          tunnel.id,
          tunnel.online ? 'online' : 'offline',
          tunnel.hostname ?? '',
          tunnel.selectors.join(' '),
          tunnel.tokenExpiresAt?.slice(0, 10) ?? 'none',
          String(tunnel.instances.length),
        ]),
      );
    });
  }
}
