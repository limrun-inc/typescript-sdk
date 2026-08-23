import { Flags } from '@oclif/core';
import { validateDestinationTunnelSelectors, type DestinationTunnelSelectors } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';
import {
  runTunnelForeground,
  serveTunnelDetached,
  startTunnelDetached,
  type TunnelClientFacade,
  type TunnelCommandContext,
} from '../../../lib/tunnel-command';
import { parseTunnelCidr, parseTunnelDomain, parseTunnelRoute } from '../../../lib/tunnel-process';

/** Bind listeners on the instance run unprivileged; system ports are refused. */
const ANDROID_MIN_ROUTE_PORT = 1024;

export default class AndroidTunnel extends BaseCommand {
  static summary = 'Route declared Android TCP destinations through this machine';
  static description =
    'Start one transparent destination tunnel. Exact --route destinations (localhost:port or IP:port) ' +
    'become listeners on the instance, also reachable as 10.0.2.2:<port> following the emulator ' +
    'convention. --domain and --cidr destinations are intercepted transparently on the instance and ' +
    'dialed from this machine. Use --detach to keep the tunnel running after this command returns. ' +
    'Note: apps that resolve DNS themselves over HTTPS (DoH) bypass --domain interception.';
  static examples = [
    '<%= config.bin %> android tunnel --route localhost:8080 --id <instance-ID>',
    '<%= config.bin %> android tunnel --domain "*.corp.example" --cidr 10.0.0.0/8 --detach',
    '<%= config.bin %> android tunnel status --id <instance-ID>',
    '<%= config.bin %> android tunnel stop --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Android instance ID to target. Defaults to the last created Android instance, but --id is recommended for scripts and agents.',
    }),
    route: Flags.string({
      description:
        'Exact TCP destination as localhost:port, IPv4:port, or [IPv6]:port (port >= 1024). Served on the instance as a listener, including on 10.0.2.2. Repeat for more routes.',
      multiple: true,
    }),
    domain: Flags.string({
      description:
        'Domain destination, exact (api.corp.example) or wildcard (*.corp.example). Intercepted via instance DNS. Repeat for more domains.',
      multiple: true,
    }),
    cidr: Flags.string({
      description: 'IPv4 CIDR destination such as 10.0.0.0/8. Repeat for more CIDRs.',
      multiple: true,
    }),
    detach: Flags.boolean({
      description: 'Run in a detached background process and return after READY.',
      default: false,
    }),
    serve: Flags.boolean({
      description: 'Internal: own the detached tunnel transport.',
      default: false,
      hidden: true,
    }),
    'tunnel-owner': Flags.string({
      description: 'Internal: detached process ownership token.',
      hidden: true,
      dependsOn: ['serve'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidTunnel);
    this.setParsedFlags(flags);
    if (flags.detach && flags.serve) {
      this.error('--detach cannot be combined with internal --serve mode.');
    }
    if (!flags.route?.length && !flags.domain?.length && !flags.cidr?.length) {
      this.error('Provide at least one --route, --domain, or --cidr destination.');
    }
    const selectors = validateDestinationTunnelSelectors({
      ...(flags.route?.length ?
        { routes: flags.route.map((route) => parseTunnelRoute(route, { minPort: ANDROID_MIN_ROUTE_PORT })) }
      : {}),
      ...(flags.domain?.length ? { domains: flags.domain.map(parseTunnelDomain) } : {}),
      ...(flags.cidr?.length ? { cidrs: flags.cidr.map(parseTunnelCidr) } : {}),
    });

    if (flags.serve) {
      const owner = flags['tunnel-owner'];
      if (!owner) this.error('--serve requires --tunnel-owner.');
      await this.withAuth(async () => {
        const resolvedInstance = this.resolveAndroidInstance(flags.id);
        await serveTunnelDetached(this.tunnelContext(resolvedInstance.id, selectors, 'info'), owner);
      });
      return;
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      if (flags.detach) {
        await startTunnelDetached(
          this.tunnelContext(resolvedInstance.id, selectors, 'info', flags['api-key']),
        );
      } else {
        await runTunnelForeground(
          this.tunnelContext(resolvedInstance.id, selectors, this.shouldSuppressInfo() ? 'none' : 'info'),
        );
      }
    });
  }

  private tunnelContext(
    instanceId: string,
    selectors: DestinationTunnelSelectors,
    logLevel: 'info' | 'none',
    apiKey?: string,
  ): TunnelCommandContext {
    return {
      product: 'android',
      instanceId,
      selectors,
      apiKey,
      reconnect: true,
      connect: async (): Promise<TunnelClientFacade> => {
        const resolvedInstance = this.resolveAndroidInstance(instanceId);
        const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
        return {
          startTunnel: (tunnelSelectors) =>
            client.startTunnel({
              ...(tunnelSelectors.routes ? { routes: tunnelSelectors.routes } : {}),
              ...(tunnelSelectors.domains ? { domains: tunnelSelectors.domains } : {}),
              ...(tunnelSelectors.cidrs ? { cidrs: tunnelSelectors.cidrs } : {}),
              logLevel,
            }),
          getTunnelStatus: () => client.getTunnelStatus(),
          stopTunnel: (tunnelId) => client.stopTunnel(tunnelId),
          disconnect,
        };
      },
      io: {
        error: (message) => this.error(message),
        output: (message) => this.output(message),
        info: (message) => this.info(message),
        outputJson: (value) => this.outputJson(value),
        isJsonEnabled: () => this.isJsonEnabled(),
      },
    };
  }
}
