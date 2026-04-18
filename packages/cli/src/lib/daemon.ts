import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createInstanceClient, Ios, type InstanceClient } from '@limrun/api';
import { type InstanceType } from './instance-client-factory';

// Unix sockets have a 104-108 byte path limit depending on OS.
// macOS tmpdir is long (~50 chars), instance IDs are ~40 chars.
// We use ~/.lim/sessions/ (shorter) and a short hash of the instance ID for the dir name.
import crypto from 'crypto';

const SESSIONS_ROOT = path.join(os.homedir(), '.lim', 'sessions');
const KEEPALIVE_INTERVAL_MS = 60 * 1000;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export { SESSIONS_ROOT };

// ---------- Per-instance paths ----------

/** Short 8-char hash of the instance ID to keep socket path under 104 bytes. */
function sessionKey(instanceId: string): string {
  return crypto.createHash('sha1').update(instanceId).digest('hex').slice(0, 8);
}

export function sessionDir(instanceId: string): string {
  return path.join(SESSIONS_ROOT, sessionKey(instanceId));
}

export function socketPath(instanceId: string): string {
  return path.join(sessionDir(instanceId), 's.sock');
}

export function pidFile(instanceId: string): string {
  return path.join(sessionDir(instanceId), 'd.pid');
}

export function stateFile(instanceId: string): string {
  return path.join(sessionDir(instanceId), 'state.json');
}

// ---------- State ----------

export interface SessionState {
  instanceId: string;
  instanceType: InstanceType;
  apiUrl: string;
  adbUrl?: string;
  token: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function saveState(instanceId: string, state: SessionState): void {
  ensureDir(sessionDir(instanceId));
  fs.writeFileSync(stateFile(instanceId), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function loadState(instanceId: string): SessionState | null {
  const p = stateFile(instanceId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearSession(instanceId: string): void {
  const dir = sessionDir(instanceId);
  try {
    fs.unlinkSync(path.join(dir, 'state.json'));
  } catch {}
  try {
    fs.unlinkSync(path.join(dir, 's.sock'));
  } catch {}
  try {
    fs.unlinkSync(path.join(dir, 'd.pid'));
  } catch {}
  try {
    fs.rmdirSync(dir);
  } catch {}
}

// ---------- Daemon lifecycle helpers ----------

export function isDaemonRunning(instanceId: string): boolean {
  const pf = pidFile(instanceId);
  if (!fs.existsSync(pf)) return false;
  const pid = parseInt(fs.readFileSync(pf, 'utf-8').trim(), 10);
  if (isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process gone — clean up stale files
    try {
      fs.unlinkSync(pf);
    } catch {}
    try {
      fs.unlinkSync(socketPath(instanceId));
    } catch {}
    return false;
  }
}

export function getDaemonPid(instanceId: string): number | null {
  const pf = pidFile(instanceId);
  if (!fs.existsSync(pf)) return null;
  const pid = parseInt(fs.readFileSync(pf, 'utf-8').trim(), 10);
  return isNaN(pid) ? null : pid;
}

/**
 * List all instance IDs that have an active daemon running.
 */
export function listActiveSessions(): { instanceId: string; pid: number }[] {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const results: { instanceId: string; pid: number }[] = [];
  for (const entry of fs.readdirSync(SESSIONS_ROOT)) {
    const dir = path.join(SESSIONS_ROOT, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const pf = path.join(dir, 'd.pid');
    if (!fs.existsSync(pf)) continue;
    const pid = parseInt(fs.readFileSync(pf, 'utf-8').trim(), 10);
    if (isNaN(pid)) continue;
    // Read state.json to get the actual instance ID (dir name is a hash)
    const sf = path.join(dir, 'state.json');
    let instanceId = entry; // fallback to hash
    try {
      const state = JSON.parse(fs.readFileSync(sf, 'utf-8'));
      if (state.instanceId) instanceId = state.instanceId;
    } catch {}
    try {
      process.kill(pid, 0);
      results.push({ instanceId, pid });
    } catch {
      // Stale — clean up
      try {
        fs.unlinkSync(pf);
      } catch {}
      try {
        fs.unlinkSync(path.join(dir, 's.sock'));
      } catch {}
      try {
        fs.unlinkSync(sf);
      } catch {}
      try {
        fs.rmdirSync(dir);
      } catch {}
    }
  }
  return results;
}

// ---------- Protocol ----------

export interface DaemonRequest {
  command: string;
  args: unknown[];
}

export interface DaemonResponse {
  type: 'stdout' | 'stderr' | 'result' | 'done';
  data?: unknown;
  exitCode?: number;
}

// ---------- Daemon server ----------

/**
 * Start the daemon server. The instance ID is read from LIM_DAEMON_INSTANCE_ID env var.
 */
export function startDaemonServer(): void {
  const instanceId = process.env.LIM_DAEMON_INSTANCE_ID;
  if (!instanceId) {
    console.error('LIM_DAEMON_INSTANCE_ID env var is required');
    process.exit(1);
  }

  const dir = sessionDir(instanceId);
  const sock = socketPath(instanceId);
  const pid = pidFile(instanceId);

  ensureDir(dir);

  // Clean up stale socket
  try {
    fs.unlinkSync(sock);
  } catch {}

  let instanceClient: (InstanceClient | Ios.InstanceClient) | null = null;
  let instanceType: InstanceType | null = null;
  let lastCommandAt = Date.now();
  let keepAliveInterval: NodeJS.Timeout | undefined;

  async function getClient(): Promise<{ type: InstanceType; client: InstanceClient | Ios.InstanceClient }> {
    if (instanceClient && instanceType) {
      return { type: instanceType, client: instanceClient };
    }

    const state = loadState(instanceId!);
    if (!state) throw new Error('No active session state found.');

    instanceType = state.instanceType as InstanceType;

    if (state.instanceType === 'android') {
      instanceClient = await createInstanceClient({
        apiUrl: state.apiUrl,
        adbUrl: state.adbUrl,
        token: state.token,
      });
    } else {
      instanceClient = await Ios.createInstanceClient({
        apiUrl: state.apiUrl,
        token: state.token,
      });
    }

    return { type: instanceType, client: instanceClient };
  }

  function disconnectClient(): void {
    if (instanceClient) {
      try {
        instanceClient.disconnect();
      } catch {}
      instanceClient = null;
      instanceType = null;
    }
  }

  function sendClientKeepAlive(client: InstanceClient | Ios.InstanceClient): void {
    const maybeClient = client as { keepAlive?: () => void };
    maybeClient.keepAlive?.();
  }

  function startKeepAliveLoop(): void {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }
    keepAliveInterval = setInterval(() => {
      if (!instanceClient) {
        return;
      }
      if (Date.now() - lastCommandAt > INACTIVITY_TIMEOUT_MS) {
        return;
      }
      try {
        sendClientKeepAlive(instanceClient);
      } catch {}
    }, KEEPALIVE_INTERVAL_MS);
  }

  function send(socket: net.Socket, resp: DaemonResponse): void {
    try {
      socket.write(JSON.stringify(resp) + '\n');
    } catch {}
  }

  async function dispatch(socket: net.Socket, req: DaemonRequest): Promise<void> {
    const { command, args } = req;
    if (command !== 'ping') {
      lastCommandAt = Date.now();
    }

    try {
      if (command === 'ping') {
        send(socket, { type: 'result', data: 'pong' });
        send(socket, { type: 'done', exitCode: 0 });
        return;
      }

      if (command === 'shutdown') {
        disconnectClient();
        send(socket, { type: 'result', data: 'daemon shutting down' });
        send(socket, { type: 'done', exitCode: 0 });
        cleanup();
        process.exit(0);
      }

      if (command === 'status') {
        const state = loadState(instanceId!);
        send(socket, {
          type: 'result',
          data:
            state ?
              { ...state, daemonPid: process.pid, connected: !!instanceClient }
            : { daemonPid: process.pid, connected: false },
        });
        send(socket, { type: 'done', exitCode: 0 });
        return;
      }

      // All other commands need an instance client
      const { type, client } = await getClient();

      let result: unknown;

      switch (command) {
        case 'screenshot':
          result = await client.screenshot();
          break;

        case 'tap':
          if (type === 'ios') {
            await (client as any).tap(args[0], args[1]);
          } else {
            await (client as any).tap({ x: args[0], y: args[1] });
          }
          result = { tapped: true, x: args[0], y: args[1] };
          break;

        case 'tap-element':
          if (type === 'ios') {
            result = await (client as any).tapElement(args[0]);
          } else {
            result = await (client as any).tap({ selector: args[0] });
          }
          break;

        case 'type':
          if (type === 'ios') {
            await (client as any).typeText(args[0], args[1]);
          } else {
            const target = typeof args[0] === 'string' || args[0] === undefined ? undefined : args[0];
            const text = typeof args[0] === 'string' ? args[0] : args[1];
            await (client as any).setText(target, text);
          }
          result = { typed: true };
          break;

        case 'press-key':
          await (client as any).pressKey(args[0], args[1]);
          result = { pressed: true, key: args[0] };
          break;

        case 'scroll':
          if (type === 'ios') {
            await (client as any).scroll(args[0], args[1]);
          } else {
            const hasTarget = typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0]);
            if (hasTarget) {
              await (client as any).scrollElement(args[0], args[1], args[2]);
            } else {
              await (client as any).scrollScreen(args[0], args[1]);
            }
          }
          result = {
            scrolled: true,
            direction:
              typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0]) ? args[1] : args[0],
          };
          break;

        case 'find-element':
          if (type !== 'android') throw new Error('find-element is only supported on Android instances');
          result = await (client as any).findElement(args[0], args[1]);
          break;

        case 'perform-actions': {
          if (type !== 'ios') throw new Error('perform-actions is only supported on iOS instances');
          const timeoutMs = typeof args[1] === 'number' ? args[1] : undefined;
          result = await (client as any).performActions(
            args[0],
            timeoutMs !== undefined ? { timeoutMs } : undefined,
          );
          break;
        }

        case 'element-tree':
          if (type === 'ios') {
            result = await (client as any).elementTree();
          } else {
            result = await (client as any).getElementTree();
          }
          break;

        case 'device-info':
          if (type !== 'ios') throw new Error('info is only supported on iOS instances');
          result = (client as any).deviceInfo;
          break;

        case 'open-url':
          await (client as any).openUrl(args[0]);
          result = { opened: true, url: args[0] };
          break;

        case 'launch-app':
          if (type !== 'ios') throw new Error('launch-app is only supported on iOS instances');
          await (client as any).launchApp(args[0], args[1]);
          result = { launched: true, bundleId: args[0] };
          break;

        case 'terminate-app':
          if (type !== 'ios') throw new Error('terminate-app is only supported on iOS instances');
          await (client as any).terminateApp(args[0]);
          result = { terminated: true, bundleId: args[0] };
          break;

        case 'list-apps':
          if (type !== 'ios') throw new Error('list-apps is only supported on iOS instances');
          result = await (client as any).listApps();
          break;

        case 'install-app':
          if (type === 'ios') {
            result = await (client as any).installApp(args[0], args[1]);
          } else {
            await (client as any).sendAsset(args[0]);
            result = { sent: true };
          }
          break;

        case 'start-recording':
          await (client as any).startRecording(args[0] ? { quality: args[0] } : undefined);
          result = { recording: true };
          break;

        case 'stop-recording':
          result = await (client as any).stopRecording(args[0] || {});
          break;

        case 'app-log-tail':
          if (type !== 'ios') throw new Error('log is only supported on iOS instances');
          result = await (client as any).appLogTail(args[0], args[1] || 100);
          break;

        default:
          throw new Error(`Unknown command: ${command}`);
      }

      send(socket, { type: 'result', data: result });
      send(socket, { type: 'done', exitCode: 0 });
    } catch (err: any) {
      send(socket, { type: 'stderr', data: err.message || String(err) });
      send(socket, { type: 'done', exitCode: 1 });
    }
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const req: DaemonRequest = JSON.parse(line);
          dispatch(socket, req).catch((err) => {
            send(socket, { type: 'stderr', data: err.message || String(err) });
            send(socket, { type: 'done', exitCode: 1 });
          });
        } catch {
          send(socket, { type: 'stderr', data: 'Invalid JSON request' });
          send(socket, { type: 'done', exitCode: 1 });
        }
      }
    });
    socket.on('error', () => {});
  });

  function cleanup(): void {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = undefined;
    }
    try {
      fs.unlinkSync(sock);
    } catch {}
    try {
      fs.unlinkSync(pid);
    } catch {}
  }

  function shutdown(): void {
    disconnectClient();
    server.close();
    cleanup();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    console.error('Daemon uncaught exception:', err);
    shutdown();
  });

  server.listen(sock, () => {
    startKeepAliveLoop();
    fs.writeFileSync(pid, String(process.pid), { mode: 0o600 });
    try {
      fs.chmodSync(sock, 0o600);
    } catch {}
    console.error(`lim daemon started for ${instanceId} (pid ${process.pid})`);
  });

  server.on('error', (err) => {
    console.error('Daemon server error:', err);
    cleanup();
    process.exit(1);
  });
}

// Entry point when run directly as a subprocess
if (require.main === module) {
  startDaemonServer();
}
