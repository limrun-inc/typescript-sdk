import { execFileSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DESTINATION_TUNNEL_MAX_BODY_BYTES,
  validateDestinationTunnelSelectors,
  type DestinationTunnelRoute,
  type DestinationTunnelSelectors,
  type DestinationTunnelStatus,
} from '@limrun/api';

export const TUNNELS_ROOT = path.join(os.homedir(), '.lim', 'tunnels');
const OWNER_PATTERN = /^[0-9a-f]{32}$/;

export type TunnelProduct = 'ios' | 'android';

export interface TunnelProcessState {
  owner: string;
  pid: number;
  instanceId: string;
  product: TunnelProduct;
  status: 'starting' | 'ready';
  selectors: DestinationTunnelSelectors;
  inspect?: boolean;
  harPath?: string;
  harBodyLimit?: number;
  startedAt: string;
  logPath: string;
  tunnelId?: string;
}

export type ReadyTunnelProcessState = TunnelProcessState & {
  status: 'ready';
  tunnelId: string;
};

export type TunnelOwnerProcessIdentity = 'match' | 'mismatch' | 'missing' | 'unknown';

export interface TunnelProcessPaths {
  directory: string;
  state: string;
  log: string;
  cancelled: string;
}

export function parseTunnelRoute(value: string, options: { minPort?: number } = {}): DestinationTunnelRoute {
  let host: string;
  let portText: string;
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(value);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Invalid route "${value}"; use [IPv6]:port`);
    }
    host = match[1];
    portText = match[2];
  } else {
    const separator = value.lastIndexOf(':');
    if (separator <= 0 || value.indexOf(':') !== separator) {
      throw new Error(`Invalid route "${value}"; use host:port or [IPv6]:port`);
    }
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }

  const port = Number(portText);
  const minPort = options.minPort ?? 1;
  if (!Number.isInteger(port) || port < minPort || port > 65_535) {
    throw new Error(`Invalid route port in "${value}"; expected ${minPort}-65535`);
  }
  // Delegate canonicalization to the shared contract validation (DNS-port
  // rejection, localhost lowering, IPv6 canonicalization and IPv4-mapped
  // unmapping, IPv4-compatible rejection).
  try {
    return validateDestinationTunnelSelectors(
      { routes: [{ host, port }] },
      options.minPort === undefined ? {} : { minRoutePort: options.minPort },
    ).routes![0]!;
  } catch (error) {
    throw new Error(
      `Invalid route "${value}"; expected localhost or a literal IP with an allowed TCP port` +
        (error instanceof Error ? ` (${error.message})` : ''),
    );
  }
}

export function parseTunnelDomain(value: string): string {
  try {
    return validateDestinationTunnelSelectors({ domains: [value] }).domains![0]!;
  } catch (error) {
    throw new Error(
      `Invalid domain "${value}"; use an exact name like api.corp.example or a wildcard like *.corp.example` +
        (error instanceof Error ? ` (${error.message})` : ''),
    );
  }
}

export function newTunnelOwner(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function formatTunnelRoute(route: DestinationTunnelRoute): string {
  const host = route.host.includes(':') ? `[${route.host}]` : route.host;
  return `${host}:${route.port}`;
}

export function formatTunnelSelectors(selectors: DestinationTunnelSelectors): string[] {
  return [
    ...(selectors.routes ?? []).map((route) => `route ${formatTunnelRoute(route)}`),
    ...(selectors.domains ?? []).map((domain) => `domain ${domain}`),
  ];
}

export function formatTunnelDialFailure(
  failure: NonNullable<DestinationTunnelStatus['lastDialFailure']>,
): string {
  const correlationIds = `tunnel ${failure.tunnelId}, connection ${failure.connectionId}, ${failure.selectorId}`;
  const failureDetails = failure.osCode ? `${failure.reason}, ${failure.osCode}` : failure.reason;
  return `Last dial failure: ${correlationIds} (${failureDetails})`;
}

export function buildTunnelServeArgs(options: {
  scriptPath: string;
  product: TunnelProduct;
  instanceId: string;
  owner: string;
  selectors: DestinationTunnelSelectors;
  inspect?: boolean;
  harPath?: string;
  harBodyLimit?: number;
  verbose?: boolean;
}): string[] {
  assertOwner(options.owner);
  return [
    options.scriptPath,
    options.product,
    'tunnel',
    '--serve',
    '--no-create',
    '--id',
    options.instanceId,
    `--tunnel-owner=${options.owner}`,
    ...(options.verbose ? ['--verbose'] : []),
    ...(options.product === 'android' && options.inspect !== undefined ?
      [options.inspect ? '--inspect' : '--no-inspect']
    : []),
    ...(options.product === 'android' && options.harPath ? ['--har', options.harPath] : []),
    ...(options.product === 'android' && options.harBodyLimit !== undefined ?
      ['--har-body-limit', String(options.harBodyLimit)]
    : []),
    ...(options.selectors.routes ?? []).flatMap((route) => ['--route', formatTunnelRoute(route)]),
    ...(options.selectors.domains ?? []).flatMap((domain) => ['--domain', domain]),
  ];
}

export function tunnelChildEnvironment(
  apiKey: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...(apiKey ? { LIM_API_KEY: apiKey } : {}),
  };
}

export async function waitForTunnelProcessReady(options: {
  load: () => TunnelProcessState | undefined;
  isAlive: () => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<
  { outcome: 'ready'; state: ReadyTunnelProcessState } | { outcome: 'exited' } | { outcome: 'timeout' }
> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 30_000);
  function loadReadyState(): ReadyTunnelProcessState | undefined {
    const state = options.load();
    if (state?.status !== 'ready' || !state.tunnelId) {
      return undefined;
    }
    return state as ReadyTunnelProcessState;
  }

  while (now() < deadline) {
    if (!options.isAlive()) return { outcome: 'exited' };
    const state = loadReadyState();
    if (state) return { outcome: 'ready', state };
    await options.sleep(options.pollMs ?? 100);
  }
  if (!options.isAlive()) return { outcome: 'exited' };
  const state = loadReadyState();
  return state ? { outcome: 'ready', state } : { outcome: 'timeout' };
}

function tunnelProcessDirectory(instanceId: string, root: string): string {
  const key = crypto.createHash('sha256').update(instanceId).digest('hex').slice(0, 12);
  return path.join(root, key);
}

export function tunnelProcessPaths(
  instanceId: string,
  owner: string,
  root = TUNNELS_ROOT,
): TunnelProcessPaths {
  assertOwner(owner);
  const directory = tunnelProcessDirectory(instanceId, root);
  return {
    directory,
    state: path.join(directory, `${owner}.json`),
    log: path.join(directory, `${owner}.log`),
    cancelled: path.join(directory, `${owner}.cancelled`),
  };
}

export function claimTunnelProcess(state: TunnelProcessState, root = TUNNELS_ROOT): boolean {
  const paths = tunnelProcessPaths(state.instanceId, state.owner, root);
  validateTunnelProcessState(state, state.instanceId, paths);
  if (fs.existsSync(paths.cancelled)) return false;
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const temporary = writeTemporaryState(state, paths);
  try {
    fs.linkSync(temporary, paths.state);
    if (fs.existsSync(paths.cancelled)) {
      fs.rmSync(paths.state, { force: true });
      return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function updateTunnelProcess(
  state: TunnelProcessState,
  expectedOwner: string,
  root = TUNNELS_ROOT,
): void {
  if (state.owner !== expectedOwner) {
    throw new Error('Tunnel process ownership changed during startup');
  }
  const paths = tunnelProcessPaths(state.instanceId, expectedOwner, root);
  validateTunnelProcessState(state, state.instanceId, paths);
  const existing = loadTunnelProcess(state.instanceId, expectedOwner, root);
  if (!existing || fs.existsSync(paths.cancelled)) {
    throw new Error('Tunnel process ownership changed during startup');
  }
  const temporary = writeTemporaryState(state, paths);
  try {
    if (fs.existsSync(paths.cancelled)) {
      throw new Error('Tunnel process ownership changed during startup');
    }
    fs.renameSync(temporary, paths.state);
    if (fs.existsSync(paths.cancelled)) {
      fs.rmSync(paths.state, { force: true });
      throw new Error('Tunnel process ownership changed during startup');
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function loadTunnelProcess(
  instanceId: string,
  owner: string,
  root = TUNNELS_ROOT,
): TunnelProcessState | undefined {
  const paths = tunnelProcessPaths(instanceId, owner, root);
  try {
    const state = JSON.parse(fs.readFileSync(paths.state, 'utf8')) as TunnelProcessState;
    validateTunnelProcessState(state, instanceId, paths);
    return state;
  } catch {
    return undefined;
  }
}

export function listTunnelProcesses(instanceId: string, root = TUNNELS_ROOT): TunnelProcessState[] {
  const directory = tunnelProcessDirectory(instanceId, root);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const states: TunnelProcessState[] = [];
  for (const entry of entries) {
    const match = /^([0-9a-f]{32})\.json$/.exec(entry);
    if (!match?.[1]) continue;
    const state = loadTunnelProcess(instanceId, match[1], root);
    if (state) states.push(state);
  }
  return states;
}

export function selectTunnelOwnersForStop(
  owners: TunnelProcessState[],
  tunnelId: string | undefined,
): TunnelProcessState[] {
  if (!tunnelId) return owners;
  return owners.filter((state) => state.status === 'starting' || state.tunnelId === tunnelId);
}

export interface TunnelLike {
  getConnectionState: () => 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  onConnectionStateChange: (
    callback: (state: 'connecting' | 'connected' | 'disconnected' | 'reconnecting') => void,
  ) => () => void;
}

export function subscribeTunnelDisconnect(tunnel: TunnelLike, onDisconnect: () => void): () => void {
  let disconnected = false;
  let unsubscribe = (): void => {};
  function observe(state: ReturnType<TunnelLike['getConnectionState']>): void {
    if (state !== 'disconnected' || disconnected) return;
    disconnected = true;
    unsubscribe();
    onDisconnect();
  }
  unsubscribe = tunnel.onConnectionStateChange(observe);
  if (disconnected) {
    unsubscribe();
  } else {
    observe(tunnel.getConnectionState());
  }
  return () => {
    disconnected = true;
    unsubscribe();
  };
}

export function stopTunnelErrorIsNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('stopTunnel failed: 404 ');
}

/**
 * Mark an owner as cancelled without removing its state. Cancellation is
 * observed by the serving child before every reconnect attempt and by every
 * state update, so a cancelled starting owner can never recreate the tunnel
 * between our stop signal and its exit.
 */
export function markTunnelProcessCancelled(instanceId: string, owner: string, root = TUNNELS_ROOT): void {
  const paths = tunnelProcessPaths(instanceId, owner, root);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(paths.cancelled, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export function isTunnelProcessCancelled(instanceId: string, owner: string, root = TUNNELS_ROOT): boolean {
  return fs.existsSync(tunnelProcessPaths(instanceId, owner, root).cancelled);
}

export function clearTunnelProcess(instanceId: string, owner: string, root = TUNNELS_ROOT): boolean {
  const paths = tunnelProcessPaths(instanceId, owner, root);
  const state = loadTunnelProcess(instanceId, owner, root);
  if (state && state.pid !== process.pid) {
    const identity = tunnelOwnerProcessIdentity(state);
    if (identity === 'match' || identity === 'unknown') return false;
  }
  markTunnelProcessCancelled(instanceId, owner, root);
  try {
    fs.unlinkSync(paths.state);
    pruneTunnelLogs(instanceId, root);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export function pruneTunnelLogs(instanceId: string, root = TUNNELS_ROOT, retain = 5): void {
  const directory = tunnelProcessDirectory(instanceId, root);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }
  const activeOwners = new Set(listTunnelProcesses(instanceId, root).map((state) => state.owner));
  const retiredLogs: Array<{ owner: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const match = /^([0-9a-f]{32})\.log$/.exec(entry);
    const owner = match?.[1];
    if (!owner || activeOwners.has(owner)) continue;

    const logPath = path.join(directory, entry);
    try {
      retiredLogs.push({
        owner,
        mtimeMs: fs.statSync(logPath).mtimeMs,
      });
    } catch {
      continue;
    }
  }
  retiredLogs.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const { owner } of retiredLogs.slice(Math.max(0, retain))) {
    const logPath = tunnelProcessPaths(instanceId, owner, root).log;
    fs.rmSync(logPath, { force: true });
    fs.rmSync(`${logPath}.1`, { force: true });
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isSpawnedTunnelProcessAlive(
  child: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  pid: number,
): boolean {
  return child.exitCode === null && child.signalCode === null && isProcessAlive(pid);
}

export function tunnelProcessStartingLeaseExpired(state: TunnelProcessState, now = Date.now()): boolean {
  return state.status === 'starting' && now - Date.parse(state.startedAt) >= 30_000;
}

export function tunnelOwnerProcessIdentity(state: TunnelProcessState): TunnelOwnerProcessIdentity {
  if (!isProcessAlive(state.pid)) return 'missing';
  try {
    let command: string;
    if (process.platform === 'win32') {
      command = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${state.pid}").CommandLine`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2_000,
        },
      );
    } else {
      command = execFileSync('/bin/ps', ['-ww', '-p', String(state.pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      });
    }

    const ownerArgument = new RegExp(`(?:^|\\s)--tunnel-owner=${state.owner}(?:\\s|$)`);
    return ownerArgument.test(command) ? 'match' : 'mismatch';
  } catch {
    return isProcessAlive(state.pid) ? 'unknown' : 'missing';
  }
}

export function signalTunnelOwner(
  state: TunnelProcessState,
  signal: NodeJS.Signals,
): 'signaled' | TunnelOwnerProcessIdentity {
  const identity = tunnelOwnerProcessIdentity(state);
  if (identity !== 'match') return identity;
  try {
    process.kill(state.pid, signal);
    return 'signaled';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'missing';
    throw error;
  }
}

export function prepareTunnelLog(logPath: string, maxBytes = 5 * 1024 * 1024): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  capTunnelLog(logPath, maxBytes);
  return fs.openSync(logPath, 'a', 0o600);
}

export function readTunnelLogTail(logPath: string, lines = 20, maxBytes = 64 * 1024): string {
  try {
    const content = readFileSuffix(logPath, maxBytes).toString('utf8').trimEnd();
    return content ? content.split('\n').slice(-lines).join('\n') : '(log file is empty)';
  } catch {
    return '(no log output captured)';
  }
}

export function capTunnelLog(logPath: string, maxBytes = 5 * 1024 * 1024): boolean {
  try {
    if (fs.statSync(logPath).size <= maxBytes) return false;
    const suffix = readFileSuffix(logPath, maxBytes);
    fs.writeFileSync(`${logPath}.1`, suffix, { mode: 0o600 });
    fs.truncateSync(logPath, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validateStoredSelectors(selectors: DestinationTunnelSelectors): DestinationTunnelSelectors {
  const canonical = validateDestinationTunnelSelectors(selectors);
  // Persisted state must already be canonical; anything else was not
  // written by us and is rejected rather than silently normalized.
  if (JSON.stringify(selectors) !== JSON.stringify(canonical)) {
    throw new Error('Invalid tunnel process state');
  }
  return canonical;
}

function validateTunnelProcessState(
  state: TunnelProcessState,
  instanceId: string,
  paths: TunnelProcessPaths,
): void {
  const startedAt = typeof state.startedAt === 'string' ? Date.parse(state.startedAt) : Number.NaN;
  const startedAtValid = Number.isFinite(startedAt) && new Date(startedAt).toISOString() === state.startedAt;
  const age = Date.now() - startedAt;
  try {
    validateStoredSelectors(state.selectors);
  } catch {
    throw new Error('Invalid tunnel process state');
  }
  const readyFieldsValid =
    state.status !== 'ready' ||
    (state.pid > 0 && typeof state.tunnelId === 'string' && state.tunnelId.length > 0);
  const startingFieldsValid = state.status !== 'starting' || state.tunnelId === undefined;
  const inspectionFieldsValid =
    (state.inspect === undefined || typeof state.inspect === 'boolean') &&
    (state.harPath === undefined || (typeof state.harPath === 'string' && state.harPath.length > 0)) &&
    (state.harBodyLimit === undefined ||
      (Number.isInteger(state.harBodyLimit) &&
        state.harBodyLimit > 0 &&
        state.harBodyLimit <= DESTINATION_TUNNEL_MAX_BODY_BYTES)) &&
    (state.harPath === undefined || state.inspect === true) &&
    (state.product === 'android' || (state.inspect === undefined && state.harPath === undefined));
  if (
    typeof state.owner !== 'string' ||
    !OWNER_PATTERN.test(state.owner) ||
    !Number.isInteger(state.pid) ||
    state.pid < 0 ||
    state.instanceId !== instanceId ||
    (state.product !== 'ios' && state.product !== 'android') ||
    (state.status !== 'starting' && state.status !== 'ready') ||
    !startedAtValid ||
    age < 0 ||
    state.logPath !== paths.log ||
    !readyFieldsValid ||
    !startingFieldsValid ||
    !inspectionFieldsValid
  ) {
    throw new Error('Invalid tunnel process state');
  }
}

function writeTemporaryState(state: TunnelProcessState, paths: TunnelProcessPaths): string {
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const temporary = `${paths.state}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(state, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return temporary;
}

function assertOwner(owner: string): void {
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error('Invalid tunnel process owner');
  }
}

function readFileSuffix(filePath: string, maxBytes: number): Buffer {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, size - length);
    return buffer;
  } finally {
    fs.closeSync(descriptor);
  }
}
