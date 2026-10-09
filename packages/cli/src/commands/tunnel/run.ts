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
    'Run it with the tunnel key the console shows (LIM_API_KEY); the key names its tunnel, and the ' +
    "tunnel's selectors decide which destinations instances reach through this machine. An admin's " +
    'login runs any tunnel with --name, and --name with --selector runs a throwaway tunnel that goes ' +
    'away when this connector exits. Instance tunnels stay up while the connection to Limrun ' +
    'reconnects. One connector holds a tunnel at a time: others wait on standby, and --replace takes ' +
    'it over.';
  static examples = [
    'LIM_API_KEY=<tunnel key> <%= config.bin %> tunnel run',
    '<%= config.bin %> tunnel run --name staging',
    '<%= config.bin %> tunnel run --name scratch --selector localhost:3000',
    '<%= config.bin %> ios create --tunnel staging',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({
      description:
        "Tunnel to run with an admin's credential. A tunnel key runs its own tunnel and needs no name.",
    }),
    selector: Flags.string({
      description:
        'Run a throwaway tunnel with this destination, as localhost:port, IPv4:port, [IPv6]:port, or a ' +
        'private exact or *. wildcard domain, when --name names no tunnel yet. A tunnel created in the ' +
        'console keeps its own selectors. Repeat for more selectors.',
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

    await this.withAuth(async () => {
      const { organizationId, tunnelId: keyTunnelId } = await whoAmITunnel(this.client);
      const tunnel = await this.resolveTunnel(organizationId, keyTunnelId, flags.name, selectors);
      // A tunnel key's tunnel learns its name from the first active.
      let name = flags.name;
      const connector = runTunnel({
        apiKey: this.client.apiKey ?? '',
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
   * The tunnel to run: the one a tunnel key names, the one --name names, or
   * a throwaway tunnel that --name and --selector create.
   */
  private async resolveTunnel(
    organizationId: string,
    keyTunnelId: string | undefined,
    name: string | undefined,
    selectors: string[] | undefined,
  ): Promise<{ id: string; created: boolean }> {
    if (keyTunnelId) {
      if (name || selectors) {
        this.error(
          "A tunnel key runs its own tunnel as created; drop --name and --selector, and edit the tunnel's " +
            'selectors in the console.',
        );
      }
      return { id: keyTunnelId, created: false };
    }
    if (!name) {
      this.error("Run with the tunnel's key (LIM_API_KEY), or pass --name with an admin's credential.");
    }
    const existing = await findTunnel(this.client, organizationId, name);
    if (existing?.ephemeral) {
      // A throwaway tunnel is its creator's alone and goes when it stops.
      this.error(`Tunnel ${name} is another connector's throwaway tunnel; pick another name.`);
    }
    if (existing) {
      if (selectors) {
        this.error(
          `Tunnel ${name} has its own selectors; edit them in the console instead of passing --selector.`,
        );
      }
      return { id: existing.id, created: false };
    }
    if (!selectors) {
      this.error(
        `Tunnel ${name} does not exist. Create it in the console (Network > New tunnel), or pass --selector to ` +
          'run a throwaway tunnel.',
      );
    }
    const created = await createQuickTunnel(this.client, organizationId, name, selectors);
    return { id: created.id, created: true };
  }
}
