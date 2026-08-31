import { Flags } from '@oclif/core';
import type { DestinationTunnelSelectors } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import {
  runTunnelForeground,
  serveTunnelDetached,
  startTunnelDetached,
  tunnelClientFacade,
  type TunnelClientFacade,
  type TunnelCommandContext,
  type TunnelLogLevel,
} from '../../../lib/tunnel-command';
import { parseTunnelSelectors } from '../../../lib/tunnel-process';

export default class IosTunnel extends BaseCommand {
  static summary = 'Expose declared local TCP destinations to the simulator';
  static description =
    'Start one transparent destination tunnel. Exact --selector destinations (localhost:port or ' +
    'literal IP:port) become listeners reachable from the simulator. Domain selectors are ' +
    'intercepted transparently on the instance and dialed from this machine, whether or not ' +
    'the name resolves on public DNS, and TLS stays end to end. ' +
    'Use --detach to keep the tunnel running after this command returns. ' +
    'Note: apps that resolve DNS themselves over HTTPS (DoH) bypass domain interception.';
  static examples = [
    '<%= config.bin %> ios tunnel --selector localhost:3000 --id <instance-ID>',
    '<%= config.bin %> ios tunnel --selector "*.corp.example" --detach',
    '<%= config.bin %> ios tunnel --selector 10.20.30.40:443 --selector 10.20.30.41:8081 --detach',
    '<%= config.bin %> ios tunnel status --id <instance-ID>',
    '<%= config.bin %> ios tunnel stop --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'iOS instance ID to target. Defaults to the last created iOS instance, but --id is recommended for scripts and agents.',
    }),
    selector: Flags.string({
      description:
        'Client-side TCP destination as localhost:port, IPv4:port, or [IPv6]:port, or a private ' +
        'exact or *. wildcard domain. Repeat for more selectors.',
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
    const selectors = parseTunnelSelectors(flags.selector);

    if (flags.serve) {
      const owner = flags['tunnel-owner'];
      if (!owner) this.error('--serve requires --tunnel-owner.');
      await this.withAuth(async () => {
        const resolvedInstance = this.resolveIosInstance(flags.id);
        await serveTunnelDetached(
          this.tunnelContext(resolvedInstance.id, selectors, flags.verbose ? 'debug' : 'info'),
          owner,
        );
      });
      return;
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      if (flags.detach) {
        await startTunnelDetached({
          ...this.tunnelContext(resolvedInstance.id, selectors, 'info', flags['api-key']),
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
  ): TunnelCommandContext {
    return {
      product: 'ios',
      instanceId,
      selectors,
      apiKey,
      reconnect: false,
      inspect: false,
      connect: async (): Promise<TunnelClientFacade> => {
        const resolvedInstance = this.resolveIosInstance(instanceId);
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        return tunnelClientFacade(client, disconnect, logLevel);
      },
      io: this.tunnelCommandIO(),
    };
  }
}
