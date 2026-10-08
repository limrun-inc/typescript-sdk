import { Flags } from '@oclif/core';
import { runTunnel } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { whoAmI } from '../../lib/backend';
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
    'Hold a tunnel name and open a destination tunnel to every iOS and Android instance created ' +
    'with --tunnel <name>, until Ctrl+C. Exact --selector destinations (localhost:port or IP:port) ' +
    'become listeners on each instance; domain selectors are intercepted on the instance and dialed ' +
    'from this machine. Instance tunnels stay up while the connection to Limrun reconnects. One ' +
    'connector holds a name at a time: others wait on standby, and --replace takes the name over. ' +
    'Needs an admin API key.';
  static examples = [
    '<%= config.bin %> tunnel run --name staging --selector localhost:3000',
    '<%= config.bin %> tunnel run --name corp --selector "*.corp.example" --selector 10.20.30.40:8443',
    '<%= config.bin %> ios create --tunnel staging',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({
      description:
        'Tunnel name that instances pass to --tunnel: a lowercase DNS label of up to 63 characters.',
      required: true,
    }),
    selector: Flags.string({
      description:
        'Client-side TCP destination as localhost:port, IPv4:port, or [IPv6]:port, or a private exact ' +
        'or *. wildcard domain. Android instances need port 1024 or higher for exact destinations. ' +
        'Repeat for more selectors.',
      multiple: true,
      required: true,
    }),
    replace: Flags.boolean({
      description: 'Take the name over from the connector that holds it now.',
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
    const selectors = parseTunnelSelectors(flags.selector);

    await this.withAuth(async () => {
      const organizationId = await whoAmI(this.client);
      const connector = runTunnel({
        apiKey: this.client.apiKey ?? '',
        baseURL: this.client.baseURL,
        organizationId,
        name: flags.name,
        selectors,
        inspection: tunnelInspectionConfig(inspection),
        replace: flags.replace,
        clientVersion: VERSION,
        logLevel:
          flags.verbose ? 'debug'
          : this.shouldSuppressInfo() ? 'none'
          : 'warn',
        onEvent: (event) => this.info(formatTunnelConnectorEvent(flags.name, event)),
      });
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
      }
    });
  }
}
