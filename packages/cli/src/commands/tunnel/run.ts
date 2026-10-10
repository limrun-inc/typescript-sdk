import { Flags } from '@oclif/core';
import { runTunnel } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  createQuickTunnel,
  deleteTunnel,
  findTunnel,
  tunnelOrganization,
  tunnelTokenClaims,
} from '../../lib/backend';
import { formatTunnelConnectorEvent } from '../../lib/tunnel-run';
import {
  tunnelInspectionConfig,
  tunnelInspectionContext,
  tunnelInspectionFlags,
  type TunnelInspectionContext,
} from '../../lib/tunnel-inspection-flags';
import { parseTunnelSelectors } from '../../lib/tunnel-process';

const VERSION = require('../../../package.json').version;

export default class TunnelRun extends BaseCommand {
  static summary = 'Serve a persistent tunnel to every instance that names it';
  static description =
    'Run the connector of a tunnel created with `lim tunnel create` or in the console (Network), and open ' +
    'a destination tunnel to every iOS and Android instance created with --tunnel <name>, until Ctrl+C. ' +
    'Run it with the tunnel token (--token or LIM_TUNNEL_TOKEN); the token names its tunnel, and the ' +
    "tunnel's selectors decide which destinations instances reach through this machine. With an " +
    "admin's login, --name and --selector run a quick tunnel that goes away when this connector " +
    'exits. Instance tunnels stay up while the connection to Limrun reconnects. One connector holds a ' +
    'tunnel at a time: others wait on standby, and --replace takes it over.';
  static examples = [
    '<%= config.bin %> tunnel run --token <tunnel token>',
    '<%= config.bin %> tunnel run --name scratch --selector localhost:3000',
    '<%= config.bin %> ios create --tunnel staging',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    token: Flags.string({
      description:
        'Tunnel token printed by `lim tunnel create` or `lim tunnel rotate`, or shown in the console.',
      env: 'LIM_TUNNEL_TOKEN',
    }),
    name: Flags.string({
      description:
        "Name of a quick tunnel to run with --selector and an admin's login. A tunnel token runs its own " +
        'tunnel and needs no name.',
    }),
    selector: Flags.string({
      description:
        'Run a quick tunnel with this destination, as localhost:port, IPv4:port, [IPv6]:port, or a ' +
        'an exact or *. wildcard domain. A created tunnel keeps its own selectors. ' +
        'Repeat for more selectors.',
      multiple: true,
    }),
    replace: Flags.boolean({
      description: 'Take the tunnel over from the connector that holds it now.',
      default: false,
    }),
    verbose: Flags.boolean({
      description: 'Log every forwarded connection and dial failure.',
      default: false,
    }),
    inspect: Flags.boolean({
      description:
        'Inspect HTTP and HTTPS through each instance tunnel with a certificate the instance trusts. ' +
        'Use --no-inspect to keep TLS end to end.',
      default: true,
      allowNo: true,
    }),
    persist: tunnelInspectionFlags.persist,
    ttl: tunnelInspectionFlags.ttl,
    'har-body-limit': tunnelInspectionFlags['har-body-limit'],
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TunnelRun);
    this.setParsedFlags(flags);
    let inspection: TunnelInspectionContext;
    try {
      inspection = tunnelInspectionContext(flags);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const selectors = flags.selector?.length ? parseTunnelSelectors(flags.selector) : undefined;

    // A tunnel token names its organization and tunnel and is the only
    // credential the connector needs. --api-key, LIM_API_KEY and lim login
    // stay an admin's, which only create quick tunnels.
    if (flags.token) {
      const claims = tunnelTokenClaims(flags.token);
      if (!claims) {
        this.error('--token takes a tunnel token, as printed by `lim tunnel create`; this is not one.');
      }
      if (flags.name || selectors) {
        this.error(
          "A tunnel token runs its own tunnel as created; drop --name and --selector, and change the tunnel's " +
            'selectors with `lim tunnel update`.',
        );
      }
      await this.serve({ ...claims, token: flags.token, created: false }, flags, inspection);
      return;
    }
    if (!flags.name) {
      this.error(
        "Run with the tunnel's token (--token or LIM_TUNNEL_TOKEN), or pass --name and --selector for a " +
          'quick tunnel.',
      );
    }
    const name = flags.name;
    await this.withAuth(async () => {
      const organizationId = await tunnelOrganization(this.client);
      const tunnel = await this.createQuick(organizationId, name, selectors);
      await this.serve(
        { organizationId, tunnelId: tunnel.id, token: tunnel.token, created: true },
        flags,
        inspection,
      );
    });
  }

  /**
   * Runs the connector with the tunnel's token until Ctrl+C or a terminal
   * error, and deletes a quick tunnel this command created on the way out.
   */
  private async serve(
    tunnel: { organizationId: string; tunnelId: string; token: string; created: boolean },
    flags: { name?: string; replace: boolean; verbose: boolean },
    inspection: TunnelInspectionContext,
  ): Promise<void> {
    // A tunnel token's tunnel learns its name from the first active.
    let name = flags.name;
    let stop: (() => void) | undefined;
    try {
      const connector = runTunnel({
        token: tunnel.token,
        baseURL: this.client.baseURL,
        organizationId: tunnel.organizationId,
        tunnelId: tunnel.tunnelId,
        inspection: tunnelInspectionConfig(inspection),
        replace: flags.replace,
        clientVersion: VERSION,
        logLevel:
          flags.verbose ? 'debug'
          : this.shouldSuppressInfo() ? 'none'
          : 'warn',
        onEvent: (event) => {
          if (event.type === 'active') name = event.name;
          this.info(formatTunnelConnectorEvent(name, event, tunnel.created));
        },
      });
      // close() says bye, which also takes a quick tunnel away.
      stop = (): void => void connector.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await connector.closed;
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (stop) {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
      // A connector stopped while connecting, refused, or out of retries
      // never said bye, so its quick tunnel would hold the name until the
      // hub sweeps it.
      if (tunnel.created) {
        await deleteTunnel(this.client, tunnel.organizationId, tunnel.tunnelId).catch((error: unknown) =>
          this.warn(
            `${error instanceof Error ? error.message : String(error)}; it goes away within ten minutes.`,
          ),
        );
      }
    }
  }

  /**
   * Creates the quick tunnel --name and --selector ask for, with its own
   * token, using the admin's credential.
   */
  private async createQuick(
    organizationId: string,
    name: string,
    selectors: string[] | undefined,
  ): Promise<{ id: string; token: string }> {
    const existing = await findTunnel(this.client, organizationId, name);
    if (existing?.ephemeral) {
      // A quick tunnel is its creator's alone and goes when it stops.
      this.error(`Tunnel ${name} is another connector's quick tunnel; pick another name.`);
    }
    if (existing) {
      this.error(
        `Tunnel ${name} runs with its own token (--token). If you no longer have it, issue a new one with ` +
          `lim tunnel rotate ${name}.`,
      );
    }
    if (!selectors) {
      this.error(
        `Tunnel ${name} does not exist. Create it with lim tunnel create ${name} --selector <destination>, or pass --selector to ` +
          'run a quick tunnel.',
      );
    }
    const created = await createQuickTunnel(this.client, organizationId, name, selectors);
    return { id: created.tunnel.id, token: created.token };
  }
}
