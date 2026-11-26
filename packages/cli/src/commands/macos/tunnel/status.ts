import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { runTunnelStatus } from '../../../lib/tunnel-command';

export default class MacosTunnelStatus extends BaseCommand {
  static summary = 'Show the active destination tunnel';
  static description =
    'Query the instance-authoritative tunnel state, most recent failure, and any local detached owner.';
  static examples = [
    '<%= config.bin %> macos tunnel status --id <instance-ID>',
    '<%= config.bin %> macos tunnel status --id <instance-ID> --json',
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
      description: 'macOS instance ID to query. Defaults to the last created macOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosTunnelStatus);
    this.setParsedFlags(flags);
    if (flags.create) {
      this.error('Tunnel status cannot create a replacement instance.');
    }
    await this.withAuth(async () => {
      const { id } = this.resolveMacosTarget(flags.id);
      await runTunnelStatus({
        instanceId: id,
        connect: async () => {
          const { client } = await this.resolveMacosClient(id);
          return {
            getTunnelStatus: () => client.getTunnelStatus(),
            stopTunnel: (tunnelId: string) => client.stopTunnel(tunnelId),
            disconnect: () => {},
          };
        },
        io: this.tunnelCommandIO(),
        renderActive: (active, io) => {
          for (const selector of active.selectors) {
            io.output(`Selector: ${selector.value}`);
          }
        },
      });
    });
  }
}
