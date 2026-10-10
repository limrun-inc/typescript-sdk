import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { findTunnel, rotateTunnelToken, tunnelOrganization } from '../../lib/backend';
import { formatIssuedToken } from '../../lib/tunnel-run';

export default class TunnelRotate extends BaseCommand {
  static summary = "Issue a persistent tunnel's token and revoke the old one";
  static description =
    'Issue a new token for a persistent tunnel and print `lim tunnel run --token <token>`. The old token ' +
    'stops working at once, and connectors running with it exit within seconds; restart them with the new ' +
    "one. Needs an admin's API key or login. With --quiet, prints only the token.";
  static examples = [
    '<%= config.bin %> tunnel rotate staging',
    '<%= config.bin %> tunnel rotate staging --expiration-months 3',
  ];

  static args = {
    name: Args.string({ description: 'Name of the tunnel whose token to rotate.', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'expiration-months': Flags.integer({
      description: 'Months until the new token expires, from 1 to 60.',
      default: 12,
      min: 1,
      max: 60,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TunnelRotate);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const organizationId = await tunnelOrganization(this.client);
      const tunnel = await findTunnel(this.client, organizationId, args.name);
      if (!tunnel) {
        this.error(`Tunnel ${args.name} does not exist.`);
      }
      // A quick tunnel's token belongs to the connector that created it: rotating it
      // ends that connector, which then deletes the tunnel and leaves the new token unusable.
      if (tunnel.ephemeral) {
        this.error(`Tunnel ${args.name} is a quick tunnel; its token lives only as long as its connector.`);
      }
      const token = await rotateTunnelToken(this.client, organizationId, tunnel, flags['expiration-months']);
      if (flags.json) {
        this.outputJson(token);
      } else if (flags.quiet) {
        this.output(token.token);
      } else {
        this.output(
          formatIssuedToken(
            `Rotated the token of tunnel ${args.name}. Connectors running with the old token exit within ` +
              'seconds; restart them with:',
            token,
          ),
        );
      }
    });
  }
}
