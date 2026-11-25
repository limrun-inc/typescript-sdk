import { Flags } from '@oclif/core';
import type { DestinationTunnelSelectors } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import {
  runTunnelForeground,
  serveTunnelDetached,
  startTunnelDetached,
  tunnelClientFacade,
  type TunnelClientFacade,
  type TunnelCommandContext,
  type TunnelLogLevel,
  type TunnelSettings,
} from '../../../lib/tunnel-command';
import {
  tunnelInspectionContext,
  tunnelInspectionFlags,
  type TunnelInspectionContext,
} from '../../../lib/tunnel-inspection-flags';
import { tunnelActivityFlags } from '../../../lib/tunnel-activity-flags';
import { parseTunnelSelectors } from '../../../lib/tunnel-process';

export default class MacosTunnel extends BaseCommand {
  static summary = 'Expose declared local TCP destinations to a macOS instance';
  static description =
    'Start one destination tunnel so code in the macOS guest reaches services on this machine. ' +
    'Exact --selector destinations (localhost:port or IPv4:port) are reachable at those addresses ' +
    'in the guest. Domain selectors resolve in the guest to addresses the tunnel serves and are ' +
    'dialed from this machine, whether or not the name resolves on public DNS. ' +
    'HTTP and HTTPS through the tunnel is inspected by default; the first inspected tunnel has the guest ' +
    "trust the instance's inspection CA, which shows a system dialog on the screen for a few seconds. " +
    'Use --no-inspect to relay traffic untouched. ' +
    'Use --detach to keep the tunnel running after this command returns. ' +
    'Connections opened before the tunnel starts keep their original route until they close.';
  static examples = [
    '<%= config.bin %> macos tunnel --selector localhost:3000 --id <instance-ID>',
    '<%= config.bin %> macos tunnel --selector "*.corp.example" --detach',
    '<%= config.bin %> macos tunnel --selector api.corp.example --har ./capture.har',
    '<%= config.bin %> macos tunnel status --id <instance-ID>',
    '<%= config.bin %> macos tunnel stop --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'macOS instance ID. Defaults to the last created macOS instance.',
    }),
    selector: Flags.string({
      description:
        'Client-side TCP destination as localhost:port or IPv4:port, or a private exact or *. ' +
        'wildcard domain. Repeat for more selectors.',
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
    ...tunnelInspectionFlags,
    ...tunnelActivityFlags,
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
    const { flags } = await this.parse(MacosTunnel);
    this.setParsedFlags(flags);
    if (flags.detach && flags.serve) {
      this.error('--detach cannot be combined with internal --serve mode.');
    }
    let inspection: TunnelInspectionContext;
    try {
      inspection = tunnelInspectionContext(flags);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const selectors = parseTunnelSelectors(flags.selector);
    const settings: TunnelSettings = {
      ...inspection,
      resetsInactivityTimeout: flags['reset-inactivity-timeout'],
    };

    if (flags.serve) {
      const owner = flags['tunnel-owner'];
      if (!owner) this.error('--serve requires --tunnel-owner.');
      await this.withAuth(async () => {
        const { id } = this.resolveMacosTarget(flags.id);
        await serveTunnelDetached(
          this.tunnelContext(id, selectors, flags.verbose ? 'debug' : 'info', settings),
          owner,
        );
      });
      return;
    }

    await this.withAuth(async () => {
      const { id } = this.resolveMacosTarget(flags.id);
      if (flags.detach) {
        await startTunnelDetached({
          ...this.tunnelContext(id, selectors, 'info', settings, flags['api-key']),
          verbose: flags.verbose,
        });
      } else {
        await runTunnelForeground(
          this.tunnelContext(
            id,
            selectors,
            this.shouldSuppressInfo() ? 'none'
            : flags.verbose ? 'debug'
            : 'info',
            settings,
          ),
        );
      }
    });
  }

  private tunnelContext(
    instanceId: string,
    selectors: DestinationTunnelSelectors,
    logLevel: TunnelLogLevel,
    settings: TunnelSettings,
    apiKey?: string,
  ): TunnelCommandContext {
    return {
      product: 'macos',
      instanceId,
      selectors,
      apiKey,
      reconnect: false,
      ...settings,
      connect: async (): Promise<TunnelClientFacade> => {
        const { client } = await this.resolveMacosClient(instanceId);
        return tunnelClientFacade(client, () => {}, logLevel);
      },
      io: this.tunnelCommandIO(),
    };
  }
}
