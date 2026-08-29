import { Flags } from '@oclif/core';
import path from 'path';
import {
  DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
  DESTINATION_TUNNEL_MAX_BODY_BYTES,
  type DestinationTunnelSelectors,
} from '@limrun/api';
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
import { parseTunnelSelectors } from '../../../lib/tunnel-process';

/** Bind listeners on the instance run unprivileged; system ports are refused. */
const ANDROID_MIN_ROUTE_PORT = 1024;

export function validateAndroidTunnelInspectionFlags(inspect: boolean, harPath?: string): void {
  if (harPath && !inspect) {
    throw new Error('--har cannot be combined with --no-inspect.');
  }
}

export default class AndroidTunnel extends BaseCommand {
  static summary = 'Send selected Android TCP destinations through this machine';
  static description =
    'Start one transparent destination tunnel. Exact --selector destinations (localhost:port or IP:port) ' +
    'become listeners on the instance, also reachable as 10.0.2.2:<port> following the emulator ' +
    'convention. Domain selectors are intercepted transparently on the instance and ' +
    'dialed from this machine. Use --detach to keep the tunnel running after this command returns. ' +
    'Start the tunnel before launching your app: connections opened earlier keep their original ' +
    'route until they close. ' +
    'Note: apps that resolve DNS themselves over HTTPS (DoH) bypass domain interception.';
  static examples = [
    '<%= config.bin %> android tunnel --selector localhost:8080 --id <instance-ID>',
    '<%= config.bin %> android tunnel --selector "*.corp.example" --detach',
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
      required: true,
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
    inspect: Flags.boolean({
      description:
        'Print one HTTP summary per completed request. Use --no-inspect to disable Android inspection.',
      default: true,
      allowNo: true,
    }),
    har: Flags.string({
      description: 'Capture inspected HTTP traffic as HAR 1.2 at this path.',
    }),
    'har-body-limit': Flags.integer({
      description: 'Maximum captured bytes per request or response body.',
      default: DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
      min: 1,
      max: DESTINATION_TUNNEL_MAX_BODY_BYTES,
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
    try {
      validateAndroidTunnelInspectionFlags(flags.inspect, flags.har);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const selectors = parseTunnelSelectors(flags.selector, { minPort: ANDROID_MIN_ROUTE_PORT });

    if (flags.serve) {
      const owner = flags['tunnel-owner'];
      if (!owner) this.error('--serve requires --tunnel-owner.');
      await this.withAuth(async () => {
        const resolvedInstance = this.resolveAndroidInstance(flags.id);
        await serveTunnelDetached(
          this.tunnelContext(resolvedInstance.id, selectors, flags.verbose ? 'debug' : 'info', undefined, {
            inspect: flags.inspect,
            ...(flags.har ? { harPath: path.resolve(flags.har) } : {}),
            harBodyLimit: flags['har-body-limit'],
          }),
          owner,
        );
      });
      return;
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      if (flags.detach) {
        await startTunnelDetached({
          ...this.tunnelContext(resolvedInstance.id, selectors, 'info', flags['api-key'], {
            inspect: flags.inspect,
            ...(flags.har ? { harPath: path.resolve(flags.har) } : {}),
            harBodyLimit: flags['har-body-limit'],
          }),
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
            undefined,
            {
              inspect: flags.inspect,
              ...(flags.har ? { harPath: path.resolve(flags.har) } : {}),
              harBodyLimit: flags['har-body-limit'],
            },
          ),
        );
      }
    });
  }

  private tunnelContext(
    instanceId: string,
    selectors: DestinationTunnelSelectors,
    logLevel: TunnelLogLevel,
    apiKey?: string,
    inspection: { inspect: boolean; harPath?: string; harBodyLimit: number } = {
      inspect: true,
      harBodyLimit: DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
    },
  ): TunnelCommandContext {
    return {
      product: 'android',
      instanceId,
      selectors,
      apiKey,
      reconnect: true,
      ...inspection,
      connect: async (): Promise<TunnelClientFacade> => {
        const resolvedInstance = this.resolveAndroidInstance(instanceId);
        const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
        return tunnelClientFacade(client, disconnect, logLevel);
      },
      io: this.tunnelCommandIO(),
    };
  }
}
