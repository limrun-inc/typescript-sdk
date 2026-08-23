import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';
import {
  formatTunnelDialFailure,
  formatTunnelSelectors,
  listTunnelProcesses,
  tunnelOwnerProcessIdentity,
} from '../../../lib/tunnel-process';

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
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
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
          const selectorLines = formatTunnelSelectors({
            ...(status.active.routes.length > 0 ? { routes: status.active.routes } : {}),
            ...(status.active.domains ? { domains: status.active.domains } : {}),
            ...(status.active.cidrs ? { cidrs: status.active.cidrs } : {}),
          });
          for (const line of selectorLines) {
            this.output(`Selector: ${line}`);
          }
          for (const [selectorId, binds] of Object.entries(status.active.binds ?? {})) {
            for (const bind of binds) {
              const detail = bind.osCode ? `${bind.status}, ${bind.osCode}` : bind.status;
              this.output(`Bind ${selectorId} ${bind.address}: ${detail}`);
            }
          }
        } else {
          this.output('No active destination tunnel.');
        }
        if (status.lastFailure) {
          this.output(`Last failure: ${status.lastFailure.tunnelId} (${status.lastFailure.code})`);
        }
        if (status.lastDialFailure) {
          this.output(formatTunnelDialFailure(status.lastDialFailure));
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
