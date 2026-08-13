import { spawn } from 'child_process';
import fs from 'fs';
import { Flags } from '@oclif/core';
import { defaultSleep, type Ios } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';
import {
  buildTunnelServeArgs,
  capTunnelLog,
  claimTunnelProcess,
  clearTunnelProcess,
  formatTunnelRoute,
  isProcessAlive,
  listTunnelProcesses,
  loadTunnelProcess,
  newTunnelOwner,
  parseTunnelRoute,
  prepareTunnelLog,
  readTunnelLogTail,
  tunnelChildEnvironment,
  tunnelOwnerProcessIdentity,
  tunnelProcessPaths,
  tunnelProcessStartingLeaseExpired,
  updateTunnelProcess,
  waitForTunnelProcessReady,
  type IosTunnelProcessState,
} from '../../../lib/ios-tunnel-process';

export default class IosTunnel extends BaseCommand {
  static summary = 'Expose declared local TCP destinations to the simulator';
  static description =
    'Start one destination-routed tunnel with exact host:port routes. The returned simulator endpoints map to those services on this machine. Use --detach to keep it running after this command returns.';
  static examples = [
    '<%= config.bin %> ios tunnel --route localhost:8000 --id <instance-ID>',
    '<%= config.bin %> ios tunnel --route api.internal:443 --route localhost:8081 --detach',
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
      description: 'Exact client-side TCP destination as host:port or [IPv6]:port. Repeat for more routes.',
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
    const routes = flags.route.map(parseTunnelRoute);

    if (flags.serve) {
      const owner = flags['tunnel-owner'];
      if (!owner) this.error('--serve requires --tunnel-owner.');
      await this.withAuth(async () => {
        const resolvedInstance = this.resolveIosInstance(flags.id);
        await this.serveDetached(resolvedInstance.id, owner, routes);
      });
      return;
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      if (flags.detach) {
        await this.startDetached(resolvedInstance.id, routes, flags['api-key']);
      } else {
        await this.runForeground(resolvedInstance.id, routes);
      }
    });
  }

  private async runForeground(instanceId: string, routes: Ios.TunnelOptions['routes']): Promise<void> {
    const resolvedInstance = this.resolveIosInstance(instanceId);
    const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
    let tunnel: Ios.Tunnel | undefined;
    try {
      tunnel = await client.startTunnel({
        routes,
        logLevel: this.shouldSuppressInfo() ? 'none' : 'info',
      });
      this.printReady(instanceId, tunnel, false);
      await this.awaitTunnel(tunnel, false);
    } finally {
      tunnel?.close();
      disconnect();
    }
  }

  private async serveDetached(
    instanceId: string,
    owner: string,
    routes: Ios.TunnelOptions['routes'],
  ): Promise<void> {
    const ownershipDeadline = Date.now() + 2_000;
    let starting = loadTunnelProcess(instanceId, owner);
    while (starting?.pid !== process.pid && Date.now() < ownershipDeadline) {
      await defaultSleep(25);
      starting = loadTunnelProcess(instanceId, owner);
    }
    if (!starting || starting.pid !== process.pid) {
      this.error('Detached tunnel ownership handshake failed.');
    }

    const resolvedInstance = this.resolveIosInstance(instanceId);
    const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
    let tunnel: Ios.Tunnel | undefined;
    const capLogs = setInterval(() => capTunnelLog(starting.logPath), 30_000);
    try {
      tunnel = await client.startTunnel({ routes, logLevel: 'info' });
      updateTunnelProcess(
        {
          ...starting,
          status: 'ready',
          routes: tunnel.bindings.map((binding) => binding.route),
          tunnelId: tunnel.tunnelId,
          bindings: tunnel.bindings,
        },
        owner,
      );
      await this.awaitTunnel(tunnel, true);
    } finally {
      clearInterval(capLogs);
      capTunnelLog(starting.logPath);
      tunnel?.close();
      disconnect();
      clearTunnelProcess(instanceId, owner);
    }
  }

  private async startDetached(
    instanceId: string,
    routes: Ios.TunnelOptions['routes'],
    apiKey: string | undefined,
  ): Promise<void> {
    await this.assertNoActiveTunnel(instanceId);
    this.clearDeadOwners(instanceId);
    const liveOwner = listTunnelProcesses(instanceId).find((state) => {
      if (state.status === 'starting' && !tunnelProcessStartingLeaseExpired(state)) {
        return true;
      }
      const identity = tunnelOwnerProcessIdentity(state);
      return identity === 'match' || identity === 'unknown';
    });
    if (liveOwner) {
      this.error(
        `A local tunnel process is already ${liveOwner.status} for ${instanceId} (PID ${liveOwner.pid}). ` +
          `Run \`lim ios tunnel status --id ${instanceId}\` or stop it first.`,
      );
    }

    const owner = newTunnelOwner();
    const paths = tunnelProcessPaths(instanceId, owner);
    const starting: IosTunnelProcessState = {
      owner,
      pid: 0,
      instanceId,
      status: 'starting',
      routes,
      startedAt: new Date().toISOString(),
      logPath: paths.log,
    };
    if (!claimTunnelProcess(starting)) {
      this.error('Failed to claim detached tunnel process state.');
    }

    const scriptPath = process.argv[1];
    if (!scriptPath) {
      clearTunnelProcess(instanceId, owner);
      this.error('Cannot locate the lim CLI entrypoint for detached startup.');
    }

    const logDescriptor = prepareTunnelLog(paths.log);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        buildTunnelServeArgs({
          scriptPath,
          instanceId,
          owner,
          routes,
        }),
        {
          detached: true,
          windowsHide: true,
          stdio: ['ignore', logDescriptor, logDescriptor],
          env: tunnelChildEnvironment(apiKey),
        },
      );
    } catch (error) {
      fs.closeSync(logDescriptor);
      clearTunnelProcess(instanceId, owner);
      throw error;
    }
    fs.closeSync(logDescriptor);
    child.unref();
    const pid = child.pid;
    if (!pid) {
      clearTunnelProcess(instanceId, owner);
      this.error('Failed to spawn the detached tunnel process.');
    }
    updateTunnelProcess({ ...starting, pid }, owner);

    const readiness = await waitForTunnelProcessReady({
      load: () => loadTunnelProcess(instanceId, owner),
      isAlive: () => isProcessAlive(pid),
      sleep: defaultSleep,
    });
    if (readiness.outcome === 'ready') {
      const state = readiness.state;
      this.printReady(
        instanceId,
        {
          tunnelId: state.tunnelId,
          bindings: state.bindings,
        },
        true,
        { pid, logPath: paths.log },
      );
      return;
    }
    if (readiness.outcome === 'exited') {
      clearTunnelProcess(instanceId, owner);
      this.error(
        `Detached tunnel exited during startup.\n${readTunnelLogTail(paths.log)}\nLogs: ${paths.log}`,
      );
    }
    child.kill('SIGTERM');
    let exited = await this.waitForProcessExit(child, pid, 20);
    if (!exited) {
      child.kill('SIGKILL');
      exited = await this.waitForProcessExit(child, pid, 20);
    }
    if (exited) {
      clearTunnelProcess(instanceId, owner);
    }
    const retainedOwnership = exited ? '' : ` and PID ${pid} did not exit; its ownership record was retained`;
    this.error(
      `Detached tunnel did not become ready within 30s${retainedOwnership}.\n` +
        `${readTunnelLogTail(paths.log)}\nLogs: ${paths.log}`,
    );
  }

  private async assertNoActiveTunnel(instanceId: string): Promise<void> {
    const resolvedInstance = this.resolveIosInstance(instanceId);
    const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
    try {
      const status = await client.getTunnelStatus();
      if (status.active) {
        this.error(
          `Tunnel ${status.active.tunnelId} is already ${status.active.state}. ` +
            `Run \`lim ios tunnel status --id ${instanceId}\` or stop it first.`,
        );
      }
    } finally {
      disconnect();
    }
  }

  private clearDeadOwners(instanceId: string): void {
    for (const state of listTunnelProcesses(instanceId)) {
      const identity = tunnelOwnerProcessIdentity(state);
      if (identity === 'unknown') {
        this.error(
          `Cannot verify local tunnel owner PID ${state.pid}; ownership state was retained at ${state.logPath}.`,
        );
      }
      if (identity === 'match') continue;
      if (state.status === 'starting' && !tunnelProcessStartingLeaseExpired(state)) continue;
      if (!clearTunnelProcess(instanceId, state.owner)) {
        this.error(
          `Cannot clean local tunnel owner PID ${state.pid}; stop it before starting another tunnel.`,
        );
      }
    }
  }

  private async awaitTunnel(tunnel: Ios.Tunnel, remoteStopIsClean: boolean): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1 << 30);
      let stopping = false;
      const cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
      };
      const shutdown = () => {
        stopping = true;
        cleanup();
        resolve();
      };
      const unsubscribe = tunnel.onConnectionStateChange((state) => {
        if (state !== 'disconnected' || stopping) return;
        cleanup();
        if (remoteStopIsClean) {
          resolve();
        } else {
          reject(new Error('Destination tunnel disconnected unexpectedly'));
        }
      });
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  }

  private async waitForProcessExit(
    child: ReturnType<typeof spawn>,
    pid: number,
    attempts: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null || !isProcessAlive(pid)) {
        return true;
      }
      await defaultSleep(100);
    }
    return !isProcessAlive(pid);
  }

  private printReady(
    instanceId: string,
    tunnel: Pick<Ios.Tunnel, 'tunnelId' | 'bindings'>,
    detached: boolean,
    processInfo?: { pid: number; logPath: string },
  ): void {
    const ready = {
      instanceId,
      tunnelId: tunnel.tunnelId,
      state: 'ready' as const,
      bindings: tunnel.bindings,
      detached,
      ...processInfo,
    };
    if (this.isJsonEnabled()) {
      this.outputJson(ready);
      return;
    }
    this.output(`Tunnel ID: ${ready.tunnelId}`);
    for (const binding of ready.bindings) {
      this.output(`${formatTunnelRoute(binding.endpoint)} -> ${formatTunnelRoute(binding.route)}`);
    }
    if (detached) {
      this.output(`Logs: ${processInfo?.logPath}`);
      this.output(`Stop: lim ios tunnel stop --id ${instanceId}`);
    } else {
      this.info('Tunnel started. Press Ctrl+C to stop.');
    }
  }
}
