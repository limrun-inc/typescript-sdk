import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';
import { runTunnelStop } from '../../../lib/tunnel-command';

export default class AndroidTunnelStop extends BaseCommand {
  static summary = 'Stop the active destination tunnel';
  static description =
    'Stop the instance-authoritative tunnel by its current ID, then gracefully stop and, if necessary, force-stop verified local detached owners.';
  static examples = [
    '<%= config.bin %> android tunnel stop --id <instance-ID>',
    '<%= config.bin %> android tunnel stop --id <instance-ID> --json',
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
      description: 'Android instance ID to stop. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidTunnelStop);
    this.setParsedFlags(flags);
    if (flags.create) {
      this.error('Tunnel stop cannot create a replacement instance.');
    }
    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      await runTunnelStop({
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
      });
    });
  }
}
