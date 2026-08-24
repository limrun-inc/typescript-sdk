import { Flags } from '@oclif/core';
import { defaultSleep } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import type { LastIosInstance } from '../../../lib/config';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import {
  clearTunnelProcess,
  isProcessAlive,
  listTunnelProcesses,
  loadTunnelProcess,
  selectTunnelOwnersForStop,
  signalTunnelOwner,
  stopTunnelErrorIsNotFound,
  tunnelOwnerProcessIdentity,
  tunnelOwnerRemainsSelectedForStop,
  type IosTunnelProcessState,
  type TunnelOwnerProcessIdentity,
} from '../../../lib/ios-tunnel-process';

type RemoteStopOutcome = { outcome: 'none' } | { outcome: 'stopped' | 'gone'; tunnelId: string };

export default class IosTunnelStop extends BaseCommand {
  static summary = 'Stop the active destination tunnel';
  static description =
    'Stop the instance-authoritative tunnel by its current ID, then gracefully stop and, if necessary, force-stop verified local detached owners.';
  static examples = [
    '<%= config.bin %> ios tunnel stop --id <instance-ID>',
    '<%= config.bin %> ios tunnel stop --id <instance-ID> --json',
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
      description: 'iOS instance ID to stop. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosTunnelStop);
    this.setParsedFlags(flags);
    if (flags.create) {
      this.error('Tunnel stop cannot create a replacement instance.');
    }
    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const ownerSnapshot = listTunnelProcesses(resolvedInstance.id);
      const remote = await this.stopRemoteTunnel(resolvedInstance);
      const expectedTunnelId = remote.outcome === 'none' ? undefined : remote.tunnelId;
      const owners = selectTunnelOwnersForStop(ownerSnapshot, expectedTunnelId);
      const local = await this.stopLocalOwners(resolvedInstance.id, owners, remote);

      if (this.isJsonEnabled()) {
        this.outputJson({
          instanceId: resolvedInstance.id,
          ...(remote.outcome === 'none' ? {} : { tunnelId: remote.tunnelId }),
          outcome: remote.outcome,
          localProcessesStopped: local.processesStopped,
          localRecordsCleaned: local.recordsCleaned,
        });
      } else if (remote.outcome === 'stopped') {
        this.output(`Stopped destination tunnel ${remote.tunnelId}.`);
      } else if (remote.outcome === 'gone') {
        this.output(`Destination tunnel ${remote.tunnelId} was already gone.`);
      } else if (local.processesStopped > 0 || local.recordsCleaned > 0) {
        this.output('Cleaned local destination tunnel ownership.');
      } else {
        this.output('No active destination tunnel.');
      }
    });
  }

  private async stopRemoteTunnel(resolvedInstance: LastIosInstance): Promise<RemoteStopOutcome> {
    const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
    try {
      const status = await client.getTunnelStatus();
      if (!status.active) return { outcome: 'none' };
      const tunnelId = status.active.tunnelId;
      try {
        await client.stopTunnel(tunnelId);
      } catch (error) {
        if (stopTunnelErrorIsNotFound(error)) {
          return { outcome: 'gone', tunnelId };
        }
        throw error;
      }
      return { outcome: 'stopped', tunnelId };
    } finally {
      disconnect();
    }
  }

  private async stopLocalOwners(
    instanceId: string,
    owners: IosTunnelProcessState[],
    remote: RemoteStopOutcome,
  ): Promise<{ processesStopped: number; recordsCleaned: number }> {
    const expectedTunnelId = remote.outcome === 'none' ? undefined : remote.tunnelId;
    let processesStopped = 0;
    let recordsCleaned = 0;
    const retainedOwners: IosTunnelProcessState[] = [];
    for (const snapshot of owners) {
      let state = loadTunnelProcess(instanceId, snapshot.owner) ?? snapshot;
      let identity = tunnelOwnerProcessIdentity(state);
      const wasRunning = identity === 'match';
      if (identity === 'match' && remote.outcome === 'stopped') {
        await this.waitForPIDExit(state.pid, 50);
      }
      state = loadTunnelProcess(instanceId, state.owner) ?? state;
      identity = tunnelOwnerProcessIdentity(state);
      if (!tunnelOwnerRemainsSelectedForStop(snapshot, state, expectedTunnelId)) {
        if (identity === 'missing' || identity === 'mismatch') {
          if (clearTunnelProcess(instanceId, state.owner)) {
            recordsCleaned++;
          } else {
            retainedOwners.push(state);
          }
        }
        continue;
      }
      if (identity === 'match') {
        identity = await this.signalOwnerAndRefreshIdentity(state, 'SIGTERM', 20);
      }
      if (identity === 'match') {
        identity = await this.signalOwnerAndRefreshIdentity(state, 'SIGKILL', 20);
      }

      if (identity === 'match' || identity === 'unknown') {
        retainedOwners.push(state);
        continue;
      }
      if (!clearTunnelProcess(instanceId, state.owner)) {
        retainedOwners.push(state);
        continue;
      }
      recordsCleaned++;
      if (wasRunning) processesStopped++;
    }
    if (retainedOwners.length > 0) {
      this.error(
        `Could not verify that ${retainedOwners.length} local tunnel process(es) exited. ` +
          `Ownership records were retained: ${retainedOwners.map((state) => state.logPath).join(', ')}`,
      );
    }
    return { processesStopped, recordsCleaned };
  }

  private async signalOwnerAndRefreshIdentity(
    state: IosTunnelProcessState,
    signal: NodeJS.Signals,
    attempts: number,
  ): Promise<TunnelOwnerProcessIdentity> {
    const result = signalTunnelOwner(state, signal);
    if (result !== 'signaled') return result;
    await this.waitForPIDExit(state.pid, attempts);
    return tunnelOwnerProcessIdentity(state);
  }

  private async waitForPIDExit(pid: number, attempts: number): Promise<void> {
    for (let attempt = 0; attempt < attempts && isProcessAlive(pid); attempt++) {
      await defaultSleep(100);
    }
  }
}
