import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { findTunnel, tunnelOrganization, updateTunnelSelectors } from '../../lib/backend';
import { parseTunnelSelectors } from '../../lib/tunnel-process';

export default class TunnelUpdate extends BaseCommand {
  static summary = "Replace a persistent tunnel's selectors";
  static description =
    "Replace a persistent tunnel's selectors. Instances attached after the change get the new ones; " +
    "restart the connector to apply them to attached instances. Needs an admin's API key or login.";
  static examples = [
    '<%= config.bin %> tunnel update staging --selector localhost:3000 --selector localhost:4000',
  ];

  static args = {
    name: Args.string({ description: 'Name of the tunnel to update.', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    selector: Flags.string({
      description:
        'Destination instances reach through the connector, as localhost:port, IPv4:port, [IPv6]:port, or ' +
        'an exact or *. wildcard domain. Repeat for more selectors; they replace the current ones.',
      multiple: true,
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TunnelUpdate);
    this.setParsedFlags(flags);
    const selectors = parseTunnelSelectors(flags.selector);

    await this.withAuth(async () => {
      const organizationId = await tunnelOrganization(this.client);
      const tunnel = await findTunnel(this.client, organizationId, args.name);
      if (!tunnel) {
        this.error(`Tunnel ${args.name} does not exist.`);
      }
      const updated = await updateTunnelSelectors(this.client, organizationId, tunnel, [...selectors]);
      if (flags.json) {
        this.outputJson(updated);
        return;
      }
      this.output(
        `Updated the selectors of tunnel ${args.name}. Instances attached from now on get them; restart the ` +
          'connector to apply them to attached instances.',
      );
    });
  }
}
