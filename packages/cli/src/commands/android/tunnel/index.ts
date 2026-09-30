import { Flags } from '@oclif/core';
import type { DestinationTunnelSelectors } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';
import {
  runTunnelForeground,
  serveTunnelDetached,
  startTunnelDetached,
  tunnelClientFacade,
  type TunnelLogLevel,
  type TunnelClientFacade,
  type TunnelCommandContext,
} from '../../../lib/tunnel-command';
import {
  tunnelInspectionContext,
  tunnelInspectionFlags,
  type TunnelInspectionContext,
} from '../../../lib/tunnel-inspection-flags';
import { parseTunnelSelectors } from '../../../lib/tunnel-process';
import {
  tunnelProxyContext,
  tunnelProxyFlags,
  type TunnelProxyContext,
} from '../../../lib/tunnel-proxy-flags';

/** Bind listeners on the instance run unprivileged; system ports are refused. */
const ANDROID_MIN_ROUTE_PORT = 1024;

export default class AndroidTunnel extends BaseCommand {
  static summary = 'Send selected Android TCP destinations through this machine';
  static description =
    'Start one transparent destination tunnel. Exact --selector destinations (localhost:port or IP:port) ' +
    'become listeners on the instance, also reachable as 10.0.2.2:<port> following the emulator ' +
    'convention. Domain selectors are intercepted transparently on the instance and ' +
    'dialed from this machine. Use --detach to keep the tunnel running after this command returns. ' +
    '--system-proxy points the device proxy at the tunnel, so every app that honors it sends its ' +
    'HTTP and HTTPS traffic through this machine. ' +
    'Start the tunnel before launching your app: connections opened earlier keep their original ' +
    'route until they close. ' +
    'Note: apps that resolve DNS themselves over HTTPS (DoH) bypass domain interception.';
  static examples = [
    '<%= config.bin %> android tunnel --selector localhost:8080 --id <instance-ID>',
    '<%= config.bin %> android tunnel --selector "*.corp.example" --detach',
    '<%= config.bin %> android tunnel --selector "*.api.example" --persist --ttl 604800',
    '<%= config.bin %> android tunnel --system-proxy --har ./traffic.har',
    '<%= config.bin %> android tunnel --system-proxy --upstream-proxy http://recorder.internal:8080 --upstream-proxy-ca ./recorder-ca.pem --detach',
    '<%= config.bin %> android tunnel status --id <instance-ID>',
    '<%= config.bin %> android tunnel stop --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Android instance ID to target. Defaults to the last created Android instance, but --id is recommended for scripts and agents.',
    }),
    selector: Flags.string({
      description:
        'Destination: localhost:port, IPv4:port, [IPv6]:port (port >= 1024), exact domain, or wildcard domain. Repeat for more selectors.',
      multiple: true,
    }),
    detach: Flags.boolean({
      description: 'Run in a detached background process and return after READY.',
      default: false,
    }),
    verbose: Flags.boolean({
      description:
        'Log every forwarded connection and dial failure. With --detach, the lines go to the tunnel log file (see tunnel status).',
      default: false,
    }),
    ...tunnelInspectionFlags,
    ...tunnelProxyFlags,
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
    let inspection: TunnelInspectionContext;
    let proxy: TunnelProxyContext;
    let selectors: DestinationTunnelSelectors;
    try {
      inspection = tunnelInspectionContext(flags);
      proxy = tunnelProxyContext(flags, inspection.inspect);
      selectors = parseTunnelSelectors(flags.selector ?? [], {
        minPort: ANDROID_MIN_ROUTE_PORT,
        systemProxy: proxy.systemProxy,
      });
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }

    if (flags.serve) {
      const owner = flags['tunnel-owner'];
      if (!owner) this.error('--serve requires --tunnel-owner.');
      await this.withAuth(async () => {
        const resolvedInstance = this.resolveAndroidInstance(flags.id);
        await serveTunnelDetached(
          this.tunnelContext(
            resolvedInstance.id,
            selectors,
            flags.verbose ? 'debug' : 'info',
            inspection,
            proxy,
          ),
          owner,
        );
      });
      return;
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      if (flags.detach) {
        await startTunnelDetached({
          ...this.tunnelContext(resolvedInstance.id, selectors, 'info', inspection, proxy, flags['api-key']),
          verbose: flags.verbose,
        });
      } else {
        await runTunnelForeground(
          this.tunnelContext(
            resolvedInstance.id,
            selectors,
            flags.verbose ? 'debug'
            : this.shouldSuppressInfo() ? 'none'
            : 'info',
            inspection,
            proxy,
          ),
        );
      }
    });
  }

  private tunnelContext(
    instanceId: string,
    selectors: DestinationTunnelSelectors,
    logLevel: TunnelLogLevel,
    inspection: TunnelInspectionContext,
    proxy: TunnelProxyContext,
    apiKey?: string,
  ): TunnelCommandContext {
    return {
      product: 'android',
      instanceId,
      selectors,
      apiKey,
      reconnect: true,
      ...inspection,
      ...proxy,
      connect: async (): Promise<TunnelClientFacade> => {
        const resolvedInstance = this.resolveAndroidInstance(instanceId);
        const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
        return tunnelClientFacade(client, disconnect, logLevel);
      },
      io: this.tunnelCommandIO(),
    };
  }
}
