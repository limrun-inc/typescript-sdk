import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Ios } from '@limrun/api';

export const IOS_TUNNELS_ROOT = path.join(os.homedir(), '.lim', 'tunnels');
const OWNER_PATTERN = /^[0-9a-f]{32}$/;

export interface IosTunnelProcessState {
  owner: string;
  pid: number;
  instanceId: string;
  status: 'starting' | 'ready';
  routes: Ios.TunnelOptions['routes'];
  startedAt: string;
  logPath: string;
  tunnelId?: string;
  bindings?: NonNullable<Ios.TunnelStatus['active']>['bindings'];
}

export type ReadyIosTunnelProcessState = IosTunnelProcessState & {
  status: 'ready';
  tunnelId: string;
  bindings: NonNullable<Ios.TunnelStatus['active']>['bindings'];
};

export interface IosTunnelProcessPaths {
  directory: string;
  state: string;
  log: string;
}

export function parseTunnelRoute(value: string): Ios.TunnelOptions['routes'][number] {
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
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid route port in "${value}"; expected 1-65535`);
  }
  return { host, port };
}

export function newTunnelOwner(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function formatTunnelRoute(route: Ios.TunnelOptions['routes'][number]): string {
  const host = route.host.includes(':') ? `[${route.host}]` : route.host;
  return `${host}:${route.port}`;
}

export function buildTunnelServeArgs(options: {
  scriptPath: string;
  instanceId: string;
  owner: string;
  routes: Ios.TunnelOptions['routes'];
}): string[] {
  assertOwner(options.owner);
  return [
    options.scriptPath,
    'ios',
    'tunnel',
    '--serve',
    '--no-create',
    '--id',
    options.instanceId,
    `--tunnel-owner=${options.owner}`,
    ...options.routes.flatMap((route) => ['--route', formatTunnelRoute(route)]),
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
  load: () => IosTunnelProcessState | undefined;
  isAlive: () => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<
  { outcome: 'ready'; state: ReadyIosTunnelProcessState } | { outcome: 'exited' } | { outcome: 'timeout' }
> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 30_000);
  function loadReadyState(): ReadyIosTunnelProcessState | undefined {
    const state = options.load();
    if (state?.status !== 'ready' || !state.tunnelId || !state.bindings) {
      return undefined;
    }
    return state as ReadyIosTunnelProcessState;
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
  root = IOS_TUNNELS_ROOT,
): IosTunnelProcessPaths {
  assertOwner(owner);
  const directory = tunnelProcessDirectory(instanceId, root);
  return {
    directory,
    state: path.join(directory, `${owner}.json`),
    log: path.join(directory, `${owner}.log`),
  };
}

export function claimTunnelProcess(state: IosTunnelProcessState, root = IOS_TUNNELS_ROOT): boolean {
  const paths = tunnelProcessPaths(state.instanceId, state.owner, root);
  validateTunnelProcessState(state, state.instanceId, paths);
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const temporary = writeTemporaryState(state, paths);
  try {
    fs.linkSync(temporary, paths.state);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function updateTunnelProcess(
  state: IosTunnelProcessState,
  expectedOwner: string,
  root = IOS_TUNNELS_ROOT,
): void {
  if (state.owner !== expectedOwner) {
    throw new Error('Tunnel process ownership changed during startup');
  }
  const paths = tunnelProcessPaths(state.instanceId, expectedOwner, root);
  validateTunnelProcessState(state, state.instanceId, paths);
  const existing = loadTunnelProcess(state.instanceId, expectedOwner, root);
  if (!existing) {
    throw new Error('Tunnel process ownership changed during startup');
  }
  const temporary = writeTemporaryState(state, paths);
  try {
    fs.renameSync(temporary, paths.state);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function loadTunnelProcess(
  instanceId: string,
  owner: string,
  root = IOS_TUNNELS_ROOT,
): IosTunnelProcessState | undefined {
  const paths = tunnelProcessPaths(instanceId, owner, root);
  try {
    const state = JSON.parse(fs.readFileSync(paths.state, 'utf8')) as IosTunnelProcessState;
    validateTunnelProcessState(state, instanceId, paths);
    return state;
  } catch {
    return undefined;
  }
}

export function listTunnelProcesses(instanceId: string, root = IOS_TUNNELS_ROOT): IosTunnelProcessState[] {
  const directory = tunnelProcessDirectory(instanceId, root);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const states: IosTunnelProcessState[] = [];
  for (const entry of entries) {
    const match = /^([0-9a-f]{32})\.json$/.exec(entry);
    if (!match?.[1]) continue;
    const state = loadTunnelProcess(instanceId, match[1], root);
    if (state) states.push(state);
  }
  return states;
}

export function clearTunnelProcess(instanceId: string, owner: string, root = IOS_TUNNELS_ROOT): boolean {
  const paths = tunnelProcessPaths(instanceId, owner, root);
  const state = loadTunnelProcess(instanceId, owner, root);
  if (state && state.pid !== process.pid && isTunnelOwnerProcessAlive(state)) {
    return false;
  }
  try {
    fs.unlinkSync(paths.state);
    pruneTunnelLogs(instanceId, root);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function pruneTunnelLogs(instanceId: string, root = IOS_TUNNELS_ROOT, retain = 5): void {
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

export function tunnelProcessStartingLeaseExpired(state: IosTunnelProcessState, now = Date.now()): boolean {
  return state.status === 'starting' && now - Date.parse(state.startedAt) >= 30_000;
}

export function isTunnelOwnerProcessAlive(state: IosTunnelProcessState): boolean {
  if (!isProcessAlive(state.pid)) return false;
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
    return ownerArgument.test(command);
  } catch {
    return false;
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

function validateStoredRoutes(routes: Ios.TunnelOptions['routes']): Ios.TunnelOptions['routes'] {
  if (!Array.isArray(routes) || routes.length < 1 || routes.length > 10) {
    throw new Error('Invalid tunnel routes');
  }
  for (const route of routes) {
    if (
      typeof route?.host !== 'string' ||
      route.host.length < 1 ||
      route.host.length > 254 ||
      Buffer.byteLength(route.host, 'utf8') !== route.host.length ||
      route.host.includes('\0') ||
      !storedRouteHostIsValid(route.host) ||
      !Number.isInteger(route.port) ||
      route.port < 1 ||
      route.port > 65_535
    ) {
      throw new Error('Invalid tunnel routes');
    }
  }
  return routes;
}

function storedRouteHostIsValid(input: string): boolean {
  let host = input.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.length > 253) return false;
  if (net.isIP(host) !== 0) return true;
  const labels = host.split('.');
  const labelsAreValid = labels.every(
    (label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
  const looksLikeAnIpAddress = labels.every((label) => /^\d+$/.test(label) || /^0x[0-9a-f]+$/.test(label));
  return labelsAreValid && !looksLikeAnIpAddress;
}

function validateTunnelProcessState(
  state: IosTunnelProcessState,
  instanceId: string,
  paths: IosTunnelProcessPaths,
): void {
  const startedAt = typeof state.startedAt === 'string' ? Date.parse(state.startedAt) : Number.NaN;
  const startedAtValid = Number.isFinite(startedAt) && new Date(startedAt).toISOString() === state.startedAt;
  const age = Date.now() - startedAt;
  let canonicalRoutes: Ios.TunnelOptions['routes'];
  try {
    canonicalRoutes = validateStoredRoutes(state.routes);
  } catch {
    throw new Error('Invalid tunnel process state');
  }
  const bindingsValid =
    state.bindings === undefined ||
    (Array.isArray(state.bindings) &&
      state.bindings.every(
        (binding) =>
          typeof binding?.routeId === 'string' &&
          binding.routeId.length > 0 &&
          validHostPort(binding.route) &&
          validHostPort(binding.endpoint),
      ));
  const readyFieldsValid =
    state.status !== 'ready' ||
    (state.pid > 0 &&
      typeof state.tunnelId === 'string' &&
      state.tunnelId.length > 0 &&
      Array.isArray(state.bindings) &&
      state.bindings.length === canonicalRoutes.length &&
      state.bindings.every((binding, index) => {
        const route = canonicalRoutes[index];
        return (
          route !== undefined &&
          binding?.routeId === `route-${index + 1}` &&
          binding?.route?.host === route.host &&
          binding?.route?.port === route.port
        );
      }));
  const startingFieldsValid =
    state.status !== 'starting' || (state.tunnelId === undefined && state.bindings === undefined);
  if (
    typeof state.owner !== 'string' ||
    !OWNER_PATTERN.test(state.owner) ||
    !Number.isInteger(state.pid) ||
    state.pid < 0 ||
    state.instanceId !== instanceId ||
    (state.status !== 'starting' && state.status !== 'ready') ||
    !startedAtValid ||
    age < 0 ||
    state.logPath !== paths.log ||
    !bindingsValid ||
    !readyFieldsValid ||
    !startingFieldsValid
  ) {
    throw new Error('Invalid tunnel process state');
  }
}

function validHostPort(value: unknown): value is { host: string; port: number } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { host?: unknown; port?: unknown };
  return (
    typeof candidate.host === 'string' &&
    candidate.host.length > 0 &&
    typeof candidate.port === 'number' &&
    Number.isInteger(candidate.port) &&
    candidate.port >= 1 &&
    candidate.port <= 65_535
  );
}

function writeTemporaryState(state: IosTunnelProcessState, paths: IosTunnelProcessPaths): string {
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
