import { nodeProxyTransport } from '../internal/proxy-transport';
import { instanceToken } from '../instance-token';
import { startTcpTunnel, type TcpTunnelOptions, type Tunnel } from '../tunnel';
import { type ExecChildProcess } from '../exec-client';
import {
  createBuildRun,
  createDaemonLogger,
  type BuildRunOptions,
  type LogLevel,
} from './daemon-client-shared';
import { MacosInstances, type MacosInstance } from './macos-instances';

export type MacosCreateClientParams = { logLevel?: LogLevel } & (
  | { instance: MacosInstance }
  | { apiUrl: string; token: string }
);

/** A point on the screen, in pixels of `screenshot()`, from the top-left corner. */
export interface MacosPoint {
  x: number;
  y: number;
}

/** Modifier keys held while a key is pressed. */
export type MacosModifier = 'shift' | 'control' | 'option' | 'command';

/** Where the guest's SSH server can be reached once {@link MacosClient.enableSsh} returns. */
export interface MacosSshAccess {
  /** The guest account the key logs in as. */
  user: string;
  /** The guest port sshd listens on; forward a local port to it with `startPortForward`. */
  port: number;
}

/**
 * MacosClient works inside a running macOS instance: it runs shell commands
 * as the guest's user, forwards local ports into the guest, and drives the
 * screen with the mouse and keyboard.
 */
export interface MacosClient {
  /**
   * Run a shell command line as the guest's user, in its login session, with
   * a login shell's PATH. `cwd` is relative to the user's home directory.
   * Output streams on `stdout` and `stderr`; the promise resolves with the
   * exit code. `kill()` ends the command and everything it started.
   */
  run(commandLine: string, options?: BuildRunOptions): ExecChildProcess;

  /**
   * Turn on the guest's SSH server and let `publicKey` (one OpenSSH public key
   * line) log in. Password logins stay off. Reach the server with
   * `startPortForward(localPort, access.port)`.
   */
  enableSsh(publicKey: string): Promise<MacosSshAccess>;

  /**
   * Accept TCP connections on `localPort` (on 127.0.0.1 unless `hostname` is
   * given) and carry each one to `remotePort` inside the guest.
   */
  startPortForward(
    localPort: number,
    remotePort: number,
    options?: TcpTunnelOptions & { hostname?: string },
  ): Promise<Tunnel>;

  /** A JPEG of the screen. Its pixels are the coordinates the input methods take. */
  screenshot(): Promise<Buffer>;

  /** Click at a point. */
  tap(point: MacosPoint, options?: { button?: 'left' | 'right' }): Promise<void>;

  /** Type text with key presses on the US layout. */
  typeText(text: string): Promise<void>;

  /**
   * Press one key, such as `enter`, `tab`, `escape`, `up`, `f5` or `a`, while
   * holding the given modifiers.
   */
  pressKey(key: string, modifiers?: MacosModifier[]): Promise<void>;

  /**
   * Scroll by `dy` (positive scrolls down) and `dx` (positive scrolls right)
   * pixels over the point, or wherever the pointer is when none is given.
   */
  scroll(options: { dx?: number; dy?: number; at?: MacosPoint }): Promise<void>;

  /** Press at `from`, move to `to` over `durationMs`, and release. */
  drag(from: MacosPoint, to: MacosPoint, options?: { durationMs?: number }): Promise<void>;

  /**
   * Restore a disk snapshot into the guest and set the key the instance saves under when it
   * terminates. A snapshot is an asset of kind `MacOSSnapshot`, so the instance's role needs read
   * on the restore keys' asset names, and create, upload and update on `key`'s.
   *
   * Each restore key is tried in order: its exact name first, then the newest asset whose name
   * starts with it, skipping snapshots saved on another macOS build. Without `restoreKeys`,
   * `key` is restored. Without either, nothing is restored. Call it once the instance is ready
   * and before using the guest; asking again joins the restore already running. Resolves with the
   * final progress event; `onProgress` sees every event, with byte counts while downloading.
   */
  restoreSnapshot(options: MacosSnapshotRestoreOptions): Promise<MacosSnapshotProgress>;
}

export interface MacosSnapshotRestoreOptions {
  /** The asset name the instance saves its changes under when it terminates. Set once. */
  key?: string;
  /** Asset names, or name prefixes, to restore from, in order. Defaults to `key`. */
  restoreKeys?: string[];
  onProgress?: (progress: MacosSnapshotProgress) => void;
}

/** A restore's progress, as the instance reports it. */
export interface MacosSnapshotProgress {
  phase: 'resolving' | 'downloading' | 'extracting' | 'restored' | 'skipped' | 'failed' | string;
  /** The asset name the restore matched. */
  key?: string;
  matchKind?: 'exact_hit' | 'prefix_hit' | string;
  /** Whether the bytes came through the regional accelerator or straight from storage. */
  source?: 'tag' | 'direct' | string;
  totalBytes?: number;
  doneBytes?: number;
  reason?: string;
  message?: string;
}

declare module './macos-instances' {
  interface MacosInstances {
    /** Create a client that works inside a running macOS instance. */
    createClient(params: MacosCreateClientParams): Promise<MacosClient>;
  }
}

// The method body lives in a subclass and is grafted onto the generated class,
// as for the other instance types, so generated files need no patch.
class MacosInstancesHelpers extends MacosInstances {
  override async createClient(params: MacosCreateClientParams): Promise<MacosClient> {
    let apiUrl: string;
    let token: string;
    if ('instance' in params) {
      if (!params.instance.status.apiUrl) {
        throw new Error('Instance not ready: apiUrl is not available');
      }
      apiUrl = params.instance.status.apiUrl;
      token = instanceToken(params.instance);
    } else {
      apiUrl = params.apiUrl;
      token = params.token;
    }
    apiUrl = apiUrl.replace(/\/+$/, '');
    const log = createDaemonLogger('[MacosInstance]', params.logLevel ?? 'info');

    async function request(path: string, init: { method: string; body?: unknown }): Promise<Response> {
      const response = await nodeProxyTransport.fetch(`${apiUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      });
      if (!response.ok) {
        const text = await response.text();
        let message = text;
        try {
          message = (JSON.parse(text) as { reason?: string; message?: string }).reason ?? message;
        } catch {
          // Not JSON; keep the text.
        }
        throw new Error(`${init.method} ${path} failed: ${response.status} ${message}`.trim());
      }
      return response;
    }

    async function post(path: string, body: unknown): Promise<void> {
      await request(path, { method: 'POST', body });
    }

    return {
      run: createBuildRun({ apiUrl, token, log }),

      async enableSsh(publicKey: string): Promise<MacosSshAccess> {
        const response = await request('/ssh', { method: 'POST', body: { publicKey } });
        return (await response.json()) as MacosSshAccess;
      },

      startPortForward(localPort, remotePort, options) {
        const url = new URL(apiUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = `${url.pathname.replace(/\/$/, '')}/port-forward`;
        url.search = '';
        url.searchParams.set('port', String(remotePort));
        const { hostname, ...tunnelOptions } = options ?? {};
        return startTcpTunnel(url.toString(), token, hostname ?? '127.0.0.1', localPort, {
          mode: 'multiplexed',
          ...tunnelOptions,
        });
      },

      async screenshot(): Promise<Buffer> {
        const response = await request('/screenshot.jpg', { method: 'GET' });
        return Buffer.from(await response.arrayBuffer());
      },

      tap(point, options) {
        return post('/tap', { x: point.x, y: point.y, ...(options?.button && { button: options.button }) });
      },

      typeText(text) {
        return post('/type', { text });
      },

      pressKey(key, modifiers) {
        return post('/press-key', { key, ...(modifiers?.length && { modifiers }) });
      },

      scroll({ dx, dy, at }) {
        return post('/scroll', { dx: dx ?? 0, dy: dy ?? 0, ...(at && { x: at.x, y: at.y }) });
      },

      async restoreSnapshot({
        onProgress,
        ...body
      }: MacosSnapshotRestoreOptions): Promise<MacosSnapshotProgress> {
        const response = await request('/snapshot', { method: 'POST', body });
        if (!response.body) throw new Error('POST /snapshot answered without a body');
        let last: MacosSnapshotProgress | undefined;
        for await (const event of readServerSentEvents(response.body)) {
          if (event.event !== 'snapshot') continue;
          last = JSON.parse(event.data) as MacosSnapshotProgress;
          onProgress?.(last);
        }
        if (!last || !['restored', 'skipped', 'failed'].includes(last.phase)) {
          throw new Error(
            `the snapshot stream ended before the restore did (last phase: ${last?.phase ?? 'none'})`,
          );
        }
        return last;
      },

      drag(from, to, options) {
        return post('/drag', {
          fromX: from.x,
          fromY: from.y,
          toX: to.x,
          toY: to.y,
          ...(options?.durationMs !== undefined && { durationMs: options.durationMs }),
        });
      },
    };
  }
}

MacosInstances.prototype.createClient = MacosInstancesHelpers.prototype.createClient;

/** readServerSentEvents yields the events of a server-sent event stream as they arrive. */
async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (data.length > 0) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
    if (data.length > 0) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}
