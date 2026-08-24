import { spawn } from 'child_process';
import fs from 'fs';
import { defaultSleep, type DestinationTunnelSelectors, type DestinationTunnelStatus } from '@limrun/api';
import {
  buildTunnelServeArgs,
  capTunnelLog,
  claimTunnelProcess,
  clearTunnelProcess,
  formatTunnelDialFailure,
  isProcessAlive,
  isSpawnedTunnelProcessAlive,
  isTunnelProcessCancelled,
  listTunnelProcesses,
  loadTunnelProcess,
  markTunnelProcessCancelled,
  newTunnelOwner,
  prepareTunnelLog,
  readTunnelLogTail,
  selectTunnelOwnersForStop,
  signalTunnelOwner,
  stopTunnelErrorIsNotFound,
  subscribeTunnelDisconnect,
  tunnelChildEnvironment,
  tunnelOwnerProcessIdentity,
  tunnelProcessPaths,
  tunnelProcessStartingLeaseExpired,
  updateTunnelProcess,
  waitForTunnelProcessReady,
  type TunnelLike,
  type TunnelOwnerProcessIdentity,
  type TunnelProcessState,
  type TunnelProduct,
} from './tunnel-process';

/** One live tunnel generation, as exposed by the SDK clients. */
export interface TunnelGeneration extends TunnelLike {
  tunnelId: string;
  close: () => void;
}

/** The subset of the client needed for status and stop flows. */
export interface TunnelManagementFacade {
  getTunnelStatus: () => Promise<DestinationTunnelStatus>;
  stopTunnel: (tunnelId: string) => Promise<void>;
  disconnect: () => void;
}

/** Product-neutral view over the iOS/Android instance clients. */
export interface TunnelClientFacade extends TunnelManagementFacade {
  startTunnel: (selectors: DestinationTunnelSelectors) => Promise<TunnelGeneration>;
}

export interface TunnelCommandIO {
  error: (message: string) => never;
  output: (message: string) => void;
  info: (message: string) => void;
  outputJson: (value: unknown) => void;
  isJsonEnabled: () => boolean;
}

export interface TunnelCommandContext {
  product: TunnelProduct;
  instanceId: string;
  selectors: DestinationTunnelSelectors;
  apiKey?: string | undefined;
  /** Reconnect with backoff after unexpected disconnects (Android behavior). */
  reconnect: boolean;
  connect: () => Promise<TunnelClientFacade>;
  io: TunnelCommandIO;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Context for status/stop flows, which never start a tunnel. */
export interface TunnelManagementContext {
  instanceId: string;
  connect: () => Promise<TunnelManagementFacade>;
  io: TunnelCommandIO;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type RemoteStopOutcome = { outcome: 'none' } | { outcome: 'stopped' | 'gone'; tunnelId: string };

const RECONNECT_INITIAL_BACKOFF_MS = 500;
const RECONNECT_MAX_BACKOFF_MS = 30_000;

export async function runTunnelForeground(context: TunnelCommandContext): Promise<void> {
  const client = await context.connect();
  const sleep = context.sleep ?? defaultSleep;
  let printedReady = false;
  let tunnel: TunnelGeneration | undefined;
  try {
    let backoffMs = RECONNECT_INITIAL_BACKOFF_MS;
    for (;;) {
      tunnel = await client.startTunnel(context.selectors);
      backoffMs = RECONNECT_INITIAL_BACKOFF_MS;
      if (!printedReady) {
        printTunnelReady(context, tunnel.tunnelId, false);
        printedReady = true;
      } else {
        context.io.info(`Tunnel reconnected with new ID ${tunnel.tunnelId}.`);
      }
      const outcome = await awaitTunnelEnd(tunnel);
      tunnel = undefined;
      if (outcome === 'shutdown') return;
      if (!context.reconnect) {
        throw new Error('Destination tunnel disconnected unexpectedly');
      }
      context.io.info(`Tunnel disconnected; reconnecting in ${backoffMs}ms...`);
      await sleep(jittered(backoffMs));
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_BACKOFF_MS);
    }
  } finally {
    tunnel?.close();
    client.disconnect();
  }
}

export async function serveTunnelDetached(context: TunnelCommandContext, owner: string): Promise<void> {
  const sleep = context.sleep ?? defaultSleep;
  const ownershipDeadline = Date.now() + 2_000;
  let starting = loadTunnelProcess(context.instanceId, owner);
  while (starting?.pid !== process.pid && Date.now() < ownershipDeadline) {
    await sleep(25);
    starting = loadTunnelProcess(context.instanceId, owner);
  }
  if (!starting || starting.pid !== process.pid) {
    context.io.error('Detached tunnel ownership handshake failed.');
  }

  const client = await context.connect();
  const capLogs = setInterval(() => capTunnelLog(starting.logPath), 30_000);
  let tunnel: TunnelGeneration | undefined;
  try {
    let backoffMs = RECONNECT_INITIAL_BACKOFF_MS;
    for (;;) {
      // A stop may have cancelled this owner while it was starting or in
      // backoff; never (re)create the tunnel for a cancelled owner.
      if (
        isTunnelProcessCancelled(context.instanceId, owner) ||
        loadTunnelProcess(context.instanceId, owner) === undefined
      ) {
        return;
      }
      tunnel = await client.startTunnel(context.selectors);
      backoffMs = RECONNECT_INITIAL_BACKOFF_MS;
      try {
        updateTunnelProcess(
          {
            ...starting,
            status: 'ready',
            tunnelId: tunnel.tunnelId,
          },
          owner,
        );
      } catch (error) {
        // Ownership was cancelled between connect and ready: tear the fresh
        // tunnel down instead of leaving an unowned server-side session.
        tunnel.close();
        throw error;
      }
      const outcome = await awaitTunnelEnd(tunnel);
      tunnel = undefined;
      if (outcome === 'shutdown') return;
      if (!context.reconnect) return;
      context.io.info(`Tunnel disconnected; reconnecting in ${backoffMs}ms...`);
      await sleep(jittered(backoffMs));
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_BACKOFF_MS);
    }
  } finally {
    clearInterval(capLogs);
    capTunnelLog(starting.logPath);
    tunnel?.close();
    client.disconnect();
    clearTunnelProcess(context.instanceId, owner);
  }
}

export async function startTunnelDetached(context: TunnelCommandContext): Promise<void> {
  await assertNoActiveTunnel(context);
  clearDeadOwners(context);
  const liveOwner = listTunnelProcesses(context.instanceId).find((state) => {
    if (state.status === 'starting' && !tunnelProcessStartingLeaseExpired(state)) {
      return true;
    }
    const identity = tunnelOwnerProcessIdentity(state);
    return identity === 'match' || identity === 'unknown';
  });
  if (liveOwner) {
    context.io.error(
      `A local tunnel process is already ${liveOwner.status} for ${context.instanceId} (PID ${liveOwner.pid}). ` +
        `Run \`lim ${context.product} tunnel status --id ${context.instanceId}\` or stop it first.`,
    );
  }

  const owner = newTunnelOwner();
  const paths = tunnelProcessPaths(context.instanceId, owner);
  const starting: TunnelProcessState = {
    owner,
    pid: 0,
    instanceId: context.instanceId,
    product: context.product,
    status: 'starting',
    selectors: context.selectors,
    startedAt: new Date().toISOString(),
    logPath: paths.log,
  };
  if (!claimTunnelProcess(starting)) {
    context.io.error('Failed to claim detached tunnel process state.');
  }

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    clearTunnelProcess(context.instanceId, owner);
    context.io.error('Cannot locate the lim CLI entrypoint for detached startup.');
  }

  const logDescriptor = prepareTunnelLog(paths.log);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      buildTunnelServeArgs({
        scriptPath,
        product: context.product,
        instanceId: context.instanceId,
        owner,
        selectors: context.selectors,
      }),
      {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logDescriptor, logDescriptor],
        env: tunnelChildEnvironment(context.apiKey),
      },
    );
  } catch (error) {
    fs.closeSync(logDescriptor);
    clearTunnelProcess(context.instanceId, owner);
    throw error;
  }
  fs.closeSync(logDescriptor);
  child.unref();
  const pid = child.pid;
  if (!pid) {
    clearTunnelProcess(context.instanceId, owner);
    context.io.error('Failed to spawn the detached tunnel process.');
  }
  updateTunnelProcess({ ...starting, pid }, owner);

  const readiness = await waitForTunnelProcessReady({
    load: () => loadTunnelProcess(context.instanceId, owner),
    isAlive: () => isSpawnedTunnelProcessAlive(child, pid),
    sleep: context.sleep ?? defaultSleep,
  });
  if (readiness.outcome === 'ready') {
    const state = readiness.state;
    printTunnelReady(context, state.tunnelId, true, { pid, logPath: paths.log });
    return;
  }
  if (readiness.outcome === 'exited') {
    clearTunnelProcess(context.instanceId, owner);
    context.io.error(
      `Detached tunnel exited during startup.\n${readTunnelLogTail(paths.log)}\nLogs: ${paths.log}`,
    );
  }
  // Cancel before killing so the child cannot finish becoming ready (or
  // reconnect) between our signal and its exit.
  markTunnelProcessCancelled(context.instanceId, owner);
  child.kill('SIGTERM');
  let exited = await waitForProcessExit(child, pid, 20, context.sleep ?? defaultSleep);
  if (!exited) {
    child.kill('SIGKILL');
    exited = await waitForProcessExit(child, pid, 20, context.sleep ?? defaultSleep);
  }
  if (exited) {
    clearTunnelProcess(context.instanceId, owner);
  }
  const retainedOwnership = exited ? '' : ` and PID ${pid} did not exit; its ownership record was retained`;
  context.io.error(
    `Detached tunnel did not become ready within 30s${retainedOwnership}.\n` +
      `${readTunnelLogTail(paths.log)}\nLogs: ${paths.log}`,
  );
}

/**
 * Shared status flow: owner listing, JSON assembly, and failure lines are
 * identical across products; only how the active tunnel's targets are
 * rendered differs (iOS shows routes, Android shows selectors and binds).
 */
export async function runTunnelStatus(
  context: TunnelManagementContext & {
    renderActive: (active: NonNullable<DestinationTunnelStatus['active']>, io: TunnelCommandIO) => void;
  },
): Promise<void> {
  const client = await context.connect();
  try {
    const status = await client.getTunnelStatus();
    const owners = listTunnelProcesses(context.instanceId).map((state) => ({
      owner: state.owner,
      pid: state.pid,
      status: state.status,
      tunnelId: state.tunnelId,
      logPath: state.logPath,
      process: tunnelOwnerProcessIdentity(state),
    }));
    if (context.io.isJsonEnabled()) {
      context.io.outputJson({
        instanceId: context.instanceId,
        ...status,
        localOwners: owners,
      });
      return;
    }

    if (status.active) {
      context.io.output(`Tunnel ${status.active.tunnelId}: ${status.active.state}`);
      context.renderActive(status.active, context.io);
    } else {
      context.io.output('No active destination tunnel.');
    }
    if (status.lastFailure) {
      context.io.output(`Last failure: ${status.lastFailure.tunnelId} (${status.lastFailure.code})`);
    }
    if (status.lastDialFailure) {
      context.io.output(formatTunnelDialFailure(status.lastDialFailure));
    }
    for (const owner of owners) {
      context.io.output(
        `Local owner: PID ${owner.pid} (${owner.process}, ${owner.status})${
          owner.logPath ? `, logs: ${owner.logPath}` : ''
        }`,
      );
    }
  } finally {
    client.disconnect();
  }
}

export async function runTunnelStop(context: TunnelManagementContext): Promise<void> {
  const ownerSnapshot = listTunnelProcesses(context.instanceId);
  const remote = await stopRemoteTunnel(context);
  const expectedTunnelId = remote.outcome === 'none' ? undefined : remote.tunnelId;
  const owners = selectTunnelOwnersForStop(ownerSnapshot, expectedTunnelId);
  const local = await stopLocalOwners(context, owners, remote);

  if (context.io.isJsonEnabled()) {
    context.io.outputJson({
      instanceId: context.instanceId,
      ...(remote.outcome === 'none' ? {} : { tunnelId: remote.tunnelId }),
      outcome: remote.outcome,
      localProcessesStopped: local.processesStopped,
      localRecordsCleaned: local.recordsCleaned,
    });
  } else if (remote.outcome === 'stopped') {
    context.io.output(`Stopped destination tunnel ${remote.tunnelId}.`);
  } else if (remote.outcome === 'gone') {
    context.io.output(`Destination tunnel ${remote.tunnelId} was already gone.`);
  } else if (local.processesStopped > 0 || local.recordsCleaned > 0) {
    context.io.output('Cleaned local destination tunnel ownership.');
  } else {
    context.io.output('No active destination tunnel.');
  }
}

async function stopRemoteTunnel(
  context: Pick<TunnelManagementContext, 'connect'>,
): Promise<RemoteStopOutcome> {
  const client = await context.connect();
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
    client.disconnect();
  }
}

async function stopLocalOwners(
  context: Pick<TunnelManagementContext, 'instanceId' | 'io' | 'sleep'>,
  owners: TunnelProcessState[],
  remote: RemoteStopOutcome,
): Promise<{ processesStopped: number; recordsCleaned: number }> {
  const sleep = context.sleep ?? defaultSleep;
  let processesStopped = 0;
  let recordsCleaned = 0;
  const retainedOwners: TunnelProcessState[] = [];
  for (const snapshot of owners) {
    // Cancel every selected owner up front: a starting or reconnecting child
    // observes the marker and can never recreate the tunnel from here on.
    markTunnelProcessCancelled(context.instanceId, snapshot.owner);
    let state = loadTunnelProcess(context.instanceId, snapshot.owner) ?? snapshot;
    let identity = tunnelOwnerProcessIdentity(state);
    const wasRunning = identity === 'match';
    if (identity === 'match' && remote.outcome === 'stopped') {
      await waitForPIDExit(state.pid, 50, sleep);
    }
    state = loadTunnelProcess(context.instanceId, state.owner) ?? state;
    identity = tunnelOwnerProcessIdentity(state);
    // Cancelled owners are always stopped, even when a reconnect gave the
    // same owner a new tunnel generation ID meanwhile.
    if (identity === 'match') {
      identity = await signalOwnerAndRefreshIdentity(state, 'SIGTERM', 20, sleep);
    }
    if (identity === 'match') {
      identity = await signalOwnerAndRefreshIdentity(state, 'SIGKILL', 20, sleep);
    }

    if (identity === 'match' || identity === 'unknown') {
      retainedOwners.push(state);
      continue;
    }
    if (!clearTunnelProcess(context.instanceId, state.owner)) {
      retainedOwners.push(state);
      continue;
    }
    recordsCleaned++;
    if (wasRunning) processesStopped++;
  }
  if (retainedOwners.length > 0) {
    context.io.error(
      `Could not verify that ${retainedOwners.length} local tunnel process(es) exited. ` +
        `Ownership records were retained: ${retainedOwners.map((state) => state.logPath).join(', ')}`,
    );
  }
  return { processesStopped, recordsCleaned };
}

async function assertNoActiveTunnel(context: TunnelCommandContext): Promise<void> {
  const client = await context.connect();
  try {
    const status = await client.getTunnelStatus();
    if (status.active) {
      context.io.error(
        `Tunnel ${status.active.tunnelId} is already ${status.active.state}. ` +
          `Run \`lim ${context.product} tunnel status --id ${context.instanceId}\` or stop it first.`,
      );
    }
  } finally {
    client.disconnect();
  }
}

function clearDeadOwners(context: TunnelCommandContext): void {
  for (const state of listTunnelProcesses(context.instanceId)) {
    const identity = tunnelOwnerProcessIdentity(state);
    if (identity === 'unknown') {
      context.io.error(
        `Cannot verify local tunnel owner PID ${state.pid}; ownership state was retained at ${state.logPath}.`,
      );
    }
    if (identity === 'match') continue;
    if (state.status === 'starting' && !tunnelProcessStartingLeaseExpired(state)) continue;
    if (!clearTunnelProcess(context.instanceId, state.owner)) {
      context.io.error(
        `Cannot clean local tunnel owner PID ${state.pid}; stop it before starting another tunnel.`,
      );
    }
  }
}

/** Resolves 'shutdown' on SIGINT/SIGTERM and 'disconnected' on tunnel loss. */
function awaitTunnelEnd(tunnel: TunnelLike): Promise<'shutdown' | 'disconnected'> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1 << 30);
    let unsubscribe = (): void => {};
    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    };
    const shutdown = () => {
      cleanup();
      resolve('shutdown');
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    unsubscribe = subscribeTunnelDisconnect(tunnel, () => {
      cleanup();
      resolve('disconnected');
    });
  });
}

async function signalOwnerAndRefreshIdentity(
  state: TunnelProcessState,
  signal: NodeJS.Signals,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<TunnelOwnerProcessIdentity> {
  const result = signalTunnelOwner(state, signal);
  if (result !== 'signaled') return result;
  await waitForPIDExit(state.pid, attempts, sleep);
  return tunnelOwnerProcessIdentity(state);
}

async function waitForPIDExit(
  pid: number,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < attempts && isProcessAlive(pid); attempt++) {
    await sleep(100);
  }
}

async function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  pid: number,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null || !isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

function jittered(delayMs: number): number {
  return Math.round(delayMs * (0.75 + Math.random() * 0.5));
}

function printTunnelReady(
  context: TunnelCommandContext,
  tunnelId: string,
  detached: boolean,
  processInfo?: { pid: number; logPath: string },
): void {
  const ready = {
    instanceId: context.instanceId,
    tunnelId,
    state: 'ready' as const,
    detached,
    ...processInfo,
  };
  if (context.io.isJsonEnabled()) {
    context.io.outputJson(ready);
    return;
  }
  context.io.output(`Tunnel ID: ${ready.tunnelId}`);
  if (detached) {
    context.io.output(`Logs: ${processInfo?.logPath}`);
    context.io.output(`Stop: lim ${context.product} tunnel stop --id ${context.instanceId}`);
  } else {
    context.io.info('Tunnel started. Press Ctrl+C to stop.');
  }
}
