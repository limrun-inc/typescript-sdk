import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import {
  formatTunnelRoute,
  listTunnelProcesses,
  tunnelOwnerProcessIdentity,
} from '../../../lib/ios-tunnel-process';

export default class IosTunnelStatus extends BaseCommand {
  static summary = 'Show the active destination tunnel';
  static description =
    'Query the instance-authoritative tunnel state, listener mappings, most recent failure, and any local detached owner.';
  static examples = [
    '<%= config.bin %> ios tunnel status --id <instance-ID>',
    '<%= config.bin %> ios tunnel status --id <instance-ID> --json',
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
      description: 'iOS instance ID to query. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosTunnelStatus);
    this.setParsedFlags(flags);
    if (flags.create) {
      this.error('Tunnel status cannot create a replacement instance.');
    }
    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const status = await client.getTunnelStatus();
        const owners = listTunnelProcesses(resolvedInstance.id).map((state) => ({
          owner: state.owner,
          pid: state.pid,
          status: state.status,
          tunnelId: state.tunnelId,
          logPath: state.logPath,
          process: tunnelOwnerProcessIdentity(state),
        }));
        if (this.isJsonEnabled()) {
          this.outputJson({
            instanceId: resolvedInstance.id,
            ...status,
            localOwners: owners,
          });
          return;
        }

        if (status.active) {
          this.output(`Tunnel ${status.active.tunnelId}: ${status.active.state}`);
          for (const binding of status.active.bindings) {
            this.output(`${formatTunnelRoute(binding.endpoint)} -> ${formatTunnelRoute(binding.route)}`);
          }
        } else {
          this.output('No active destination tunnel.');
        }
        if (status.lastFailure) {
          this.output(`Last failure: ${status.lastFailure.tunnelId} (${status.lastFailure.code})`);
        }
        for (const owner of owners) {
          this.output(
            `Local owner: PID ${owner.pid} (${owner.process}, ${owner.status})${
              owner.logPath ? `, logs: ${owner.logPath}` : ''
            }`,
          );
        }
      } finally {
        disconnect();
      }
    });
  }
}
