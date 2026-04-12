import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Limrun, { createInstanceClient, Ios, type InstanceClient } from '@limrun/api';
import { detectInstanceType, type InstanceType } from './instance-client-factory';
import { readConfig } from './config';

const SESSION_DIR = path.join(os.tmpdir(), 'lim-session');
const SOCKET_PATH = path.join(SESSION_DIR, 'daemon.sock');
const PID_FILE = path.join(SESSION_DIR, 'daemon.pid');
const STATE_FILE = path.join(SESSION_DIR, 'state.json');

export { SOCKET_PATH, PID_FILE, STATE_FILE, SESSION_DIR };

// ---------- State ----------

export interface SessionState {
  instanceId: string;
  instanceType: InstanceType;
  apiUrl: string;
  adbUrl?: string;
  token: string;
}

function ensureSessionDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  }
}

export function saveState(state: SessionState): void {
  ensureSessionDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function loadState(): SessionState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearState(): void {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

// ---------- Daemon lifecycle helpers (used by CLI) ----------

export function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (isNaN(pid)) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness check
    return true;
  } catch {
    // Process gone — clean up stale files
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    return false;
  }
}

export function getDaemonPid(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  return isNaN(pid) ? null : pid;
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

export function startDaemonServer(): void {
  ensureSessionDir();

  // Clean up stale socket
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  let instanceClient: (InstanceClient | Ios.InstanceClient) | null = null;
  let instanceType: InstanceType | null = null;

  async function getClient(): Promise<{ type: InstanceType; client: InstanceClient | Ios.InstanceClient }> {
    if (instanceClient && instanceType) {
      return { type: instanceType, client: instanceClient };
    }

    const state = loadState();
    if (!state) throw new Error('No active session. Run `lim session start <ID>` first.');

    instanceType = state.instanceType;

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
      try { instanceClient.disconnect(); } catch {}
      instanceClient = null;
      instanceType = null;
    }
  }

  function send(socket: net.Socket, resp: DaemonResponse): void {
    try {
      socket.write(JSON.stringify(resp) + '\n');
    } catch {}
  }

  async function dispatch(socket: net.Socket, req: DaemonRequest): Promise<void> {
    const { command, args } = req;

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
        const state = loadState();
        send(socket, {
          type: 'result',
          data: state
            ? { ...state, daemonPid: process.pid, connected: !!instanceClient }
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
            await (client as any).setText(undefined, args[0]);
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
            await (client as any).scrollScreen(args[0], args[1]);
          }
          result = { scrolled: true, direction: args[0] };
          break;

        case 'element-tree':
          if (type === 'ios') {
            result = await (client as any).elementTree();
          } else {
            result = await (client as any).getElementTree();
          }
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
    socket.on('error', () => {}); // Ignore client disconnects
  });

  function cleanup(): void {
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
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

  server.listen(SOCKET_PATH, () => {
    fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
    console.error(`lim daemon started (pid ${process.pid}, socket ${SOCKET_PATH})`);
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
