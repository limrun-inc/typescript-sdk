import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { runTunnelStop } from '../../../lib/tunnel-command';

export default class MacosTunnelStop extends BaseCommand {
  static summary = 'Stop the active destination tunnel';
  static description =
    'Stop the instance-authoritative tunnel by its current ID, then gracefully stop and, if necessary, force-stop verified local detached owners.';
  static examples = [
    '<%= config.bin %> macos tunnel stop --id <instance-ID>',
    '<%= config.bin %> macos tunnel stop --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({
      description: 'Create a replacement instance if the target is gone. Disabled by default for stop.',
      default: false,
      allowNo: true,
      hidden: true,
    }),
    id: Flags.string({
      description: 'macOS instance ID to stop. Defaults to the last created macOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MacosTunnelStop);
    this.setParsedFlags(flags);
    if (flags.create) {
      this.error('Tunnel stop cannot create a replacement instance.');
    }
    await this.withAuth(async () => {
      const { id } = this.resolveMacosTarget(flags.id);
      await runTunnelStop({
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
      });
    });
  }
}
