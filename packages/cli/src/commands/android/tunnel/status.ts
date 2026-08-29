import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';
import { runTunnelStatus } from '../../../lib/tunnel-command';

export default class AndroidTunnelStatus extends BaseCommand {
  static summary = 'Show the active destination tunnel';
  static description =
    'Query the instance-authoritative tunnel state, per-selector bind results, most recent failure, and any local detached owner.';
  static examples = [
    '<%= config.bin %> android tunnel status --id <instance-ID>',
    '<%= config.bin %> android tunnel status --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({
      description:
        'Create a replacement instance if the target is gone. Disabled by default for status queries.',
      default: false,
      allowNo: true,
      hidden: true,
    }),
    id: Flags.string({
      description: 'Android instance ID to query. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidTunnelStatus);
    this.setParsedFlags(flags);
    if (flags.create) {
      this.error('Tunnel status cannot create a replacement instance.');
    }
    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      await runTunnelStatus({
        instanceId: resolvedInstance.id,
        connect: async () => {
          const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
          return {
            getTunnelStatus: () => client.getTunnelStatus(),
            stopTunnel: (tunnelId: string) => client.stopTunnel(tunnelId),
            disconnect,
          };
        },
        io: this.tunnelCommandIO(),
        renderActive: (active, io) => {
          const inspection = active.inspection;
          io.output(
            `Inspection: ${inspection.enabled ? 'enabled' : 'disabled'}, bodies ${
              inspection.captureBodies ? 'enabled' : 'disabled'
            }, persistence ${inspection.persist ? `enabled (${inspection.ttlSeconds}s)` : 'disabled'}`,
          );
          for (const selector of active.selectors) {
            io.output(`Selector: ${selector.value}`);
            for (const bind of selector.binds ?? []) {
              const detail = bind.osCode ? `${bind.status}, ${bind.osCode}` : bind.status;
              io.output(`Bind ${selector.id} ${bind.address}: ${detail}`);
            }
          }
        },
      });
    });
  }
}
