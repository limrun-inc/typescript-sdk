import { Flags } from '@oclif/core';
import { runTunnel } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { createQuickTunnel, deleteQuickTunnel, findTunnel, whoAmITunnel } from '../../lib/backend';
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
    'Run the connector of a tunnel created in the console (Network > New tunnel) or the API, and open ' +
    'a destination tunnel to every iOS and Android instance created with --tunnel <name>, until Ctrl+C. ' +
    'Run it with the tunnel token the console shows (--token); the token names its tunnel, and the ' +
    "tunnel's selectors decide which destinations instances reach through this machine. With an " +
    "admin's login, --name and --selector run a throwaway tunnel that goes away when this connector " +
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
        'Tunnel token from the console (Network > New tunnel). Takes precedence over --api-key and LIM_API_KEY.',
    }),
    name: Flags.string({
      description:
        "Name of a throwaway tunnel to run with --selector and an admin's login. A tunnel token runs its own " +
        'tunnel and needs no name.',
    }),
    selector: Flags.string({
      description:
        'Run a throwaway tunnel with this destination, as localhost:port, IPv4:port, [IPv6]:port, or a ' +
        'private exact or *. wildcard domain. A tunnel created in the console keeps its own selectors. ' +
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
    // A tunnel token authenticates like an API key and wins over one already in the shell.
    this.setParsedFlags(flags.token ? { ...flags, 'api-key': flags.token } : flags);
    let inspection: TunnelInspectionContext;
    try {
      inspection = tunnelInspectionContext(flags);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const selectors = flags.selector?.length ? parseTunnelSelectors(flags.selector) : undefined;

    await this.withAuth(async () => {
      const { organizationId, tunnelId: tokenTunnelId } = await whoAmITunnel(this.client);
      const tunnel = await this.resolveTunnel(organizationId, tokenTunnelId, flags.name, selectors);
      // A tunnel token's tunnel learns its name from the first active.
      let name = flags.name;
      const connector = runTunnel({
        // Only tunnel tokens connect: a throwaway tunnel runs with its own.
        apiKey: tunnel.token ?? this.client.apiKey ?? '',
        baseURL: this.client.baseURL,
        organizationId,
        tunnelId: tunnel.id,
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
      // close() says bye, which also takes a throwaway tunnel away.
      const stop = (): void => void connector.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await connector.closed;
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        // A connector stopped while connecting, refused, or out of retries
        // never said bye, so its throwaway tunnel would hold the name until
        // the hub sweeps it.
        if (tunnel.created) {
          await deleteQuickTunnel(this.client, organizationId, tunnel.id).catch((error: unknown) =>
            this.warn(
              `${error instanceof Error ? error.message : String(error)}; it goes away within ten minutes.`,
            ),
          );
        }
      }
    });
  }

  /**
   * The tunnel to run: the one a tunnel token names, or a throwaway tunnel
   * that --name and --selector create with its own token.
   */
  private async resolveTunnel(
    organizationId: string,
    tokenTunnelId: string | undefined,
    name: string | undefined,
    selectors: string[] | undefined,
  ): Promise<{ id: string; created: boolean; token?: string }> {
    if (tokenTunnelId) {
      if (name || selectors) {
        this.error(
          "A tunnel token runs its own tunnel as created; drop --name and --selector, and edit the tunnel's " +
            'selectors in the console.',
        );
      }
      return { id: tokenTunnelId, created: false };
    }
    if (!name) {
      this.error(
        "Run with the tunnel's token (--token), or pass --name and --selector for a throwaway tunnel.",
      );
    }
    const existing = await findTunnel(this.client, organizationId, name);
    if (existing?.ephemeral) {
      // A throwaway tunnel is its creator's alone and goes when it stops.
      this.error(`Tunnel ${name} is another connector's throwaway tunnel; pick another name.`);
    }
    if (existing) {
      this.error(
        `Tunnel ${name} runs with its own token (--token). Rotate it in the console (Network) if you no ` +
          'longer have it.',
      );
    }
    if (!selectors) {
      this.error(
        `Tunnel ${name} does not exist. Create it in the console (Network > New tunnel), or pass --selector to ` +
          'run a throwaway tunnel.',
      );
    }
    const created = await createQuickTunnel(this.client, organizationId, name, selectors);
    return { id: created.tunnel.id, created: true, token: created.token };
  }
}
