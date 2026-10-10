import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { createTunnel, tunnelOrganization } from '../../lib/backend';
import { formatIssuedToken } from '../../lib/tunnel-run';
import { parseTunnelSelectors } from '../../lib/tunnel-process';

export default class TunnelCreate extends BaseCommand {
  static summary = 'Create a persistent tunnel and print the command that runs it';
  static description =
    'Create a persistent tunnel that serves every iOS and Android instance created with --tunnel <name>, ' +
    'and print `lim tunnel run --token <token>` for its connector. The token runs this tunnel and nothing ' +
    "else, and it is shown only once. Needs an admin's API key or login. With --quiet, prints only the token.";
  static examples = [
    '<%= config.bin %> tunnel create staging --selector localhost:3000 --selector "*.internal.example.com"',
    '<%= config.bin %> tunnel create staging --selector localhost:3000 --expiration-months 3',
  ];

  static args = {
    name: Args.string({
      description:
        'Tunnel name that instances use with --tunnel: lowercase letters, digits and dashes, at most 63 ' +
        'characters. It cannot be changed later.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    selector: Flags.string({
      description:
        'Destination instances reach through the connector, as localhost:port, IPv4:port, [IPv6]:port, or ' +
        'an exact or *. wildcard domain. Repeat for more selectors.',
      multiple: true,
      required: true,
    }),
    'expiration-months': Flags.integer({
      description: 'Months until the token expires, from 1 to 60.',
      default: 12,
      min: 1,
      max: 60,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TunnelCreate);
    this.setParsedFlags(flags);
    const selectors = parseTunnelSelectors(flags.selector);

    await this.withAuth(async () => {
      const organizationId = await tunnelOrganization(this.client);
      const created = await createTunnel(this.client, organizationId, {
        name: args.name,
        selectors: [...selectors],
        expirationMonths: flags['expiration-months'],
      });
      if (flags.json) {
        this.outputJson(created);
      } else if (flags.quiet) {
        this.output(created.token.token);
      } else {
        this.output(
          formatIssuedToken(
            `Created tunnel ${args.name}. Run its connector on a machine that reaches its selectors:`,
            created.token,
          ),
        );
      }
    });
  }
}
