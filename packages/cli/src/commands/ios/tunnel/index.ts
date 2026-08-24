import { Flags } from '@oclif/core';
import { validateDestinationTunnelSelectors, type DestinationTunnelSelectors } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import {
  runTunnelForeground,
  serveTunnelDetached,
  startTunnelDetached,
  type TunnelClientFacade,
  type TunnelCommandContext,
} from '../../../lib/tunnel-command';
import { parseTunnelRoute } from '../../../lib/tunnel-process';

export default class IosTunnel extends BaseCommand {
  static summary = 'Expose declared local TCP destinations to the simulator';
  static description =
    'Start one transparent destination tunnel with exact localhost:port or literal IP:port routes. Use --detach to keep it running after this command returns.';
  static examples = [
    '<%= config.bin %> ios tunnel --route localhost:3000 --id <instance-ID>',
    '<%= config.bin %> ios tunnel --route 10.20.30.40:443 --route 10.20.30.41:8081 --detach',
    '<%= config.bin %> ios tunnel status --id <instance-ID>',
    '<%= config.bin %> ios tunnel stop --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'iOS instance ID to target. Defaults to the last created iOS instance, but --id is recommended for scripts and agents.',
    }),
    route: Flags.string({
      description:
        'Exact client-side TCP destination as localhost:port, IPv4:port, or [IPv6]:port. Repeat for more routes.',
      multiple: true,
      required: true,
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
    const { flags } = await this.parse(IosTunnel);
    this.setParsedFlags(flags);
    if (flags.detach && flags.serve) {
      this.error('--detach cannot be combined with internal --serve mode.');
    }
    const selectors = validateDestinationTunnelSelectors({
      routes: flags.route.map((route) => parseTunnelRoute(route)),
    });

    if (flags.serve) {
      const owner = flags['tunnel-owner'];
      if (!owner) this.error('--serve requires --tunnel-owner.');
      await this.withAuth(async () => {
        const resolvedInstance = this.resolveIosInstance(flags.id);
        await serveTunnelDetached(this.tunnelContext(resolvedInstance.id, selectors, 'info'), owner);
      });
      return;
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      if (flags.detach) {
        await startTunnelDetached(
          this.tunnelContext(resolvedInstance.id, selectors, 'info', flags['api-key']),
        );
      } else {
        await runTunnelForeground(
          this.tunnelContext(
            resolvedInstance.id,
            selectors,
            this.shouldSuppressInfo() ? 'none' : 'info',
          ),
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
      product: 'ios',
      instanceId,
      selectors,
      apiKey,
      reconnect: false,
      connect: async (): Promise<TunnelClientFacade> => {
        const resolvedInstance = this.resolveIosInstance(instanceId);
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        return {
          startTunnel: (tunnelSelectors) =>
            client.startTunnel({
              routes: tunnelSelectors.routes ?? [],
              logLevel,
            }),
          getTunnelStatus: () => client.getTunnelStatus(),
          stopTunnel: (tunnelId) => client.stopTunnel(tunnelId),
          disconnect,
        };
      },
      io: this.tunnelCommandIO(),
    };
  }
}
