import { nodeProxyTransport } from '../internal/proxy-transport';
import { directInstanceErrorReason } from '../internal/direct-instance-errors';
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
import {
  destinationTunnelDialOptions,
  startDestinationTcpTunnel,
  type DestinationTcpTunnel,
  type DestinationTunnelStartOptions,
} from '../destination-tunnel-dialer';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';
import { downloadFileToLocalPath } from '../internal/download-file';
import { persistFields, ttlFields, type PersistOption } from '../internal/persist-option';
import { streamSessionEntries } from '../internal/session-stream';
import { postTrustedCaCertificate, type TrustedCaCertificate } from '../internal/trusted-ca';
import {
  type PerformanceSample,
  type SessionArtifact,
  type SessionArtifactKind,
  type SessionEvent,
  type SessionLogLine,
} from './session-artifacts';
import {
  getDestinationTunnelStatus,
  stopDestinationTunnel,
  type DestinationTunnelStatus,
} from '../internal/destination-tunnel-management';
import { deriveDestinationTunnelURL } from '../internal/destination-tunnel-url';

export type MacosCreateClientParams = { logLevel?: LogLevel } & (
  | { instance: MacosInstance }
  | { apiUrl: string; token: string }
);

/**
 * Options of {@link MacosClient.startTunnel}, as on iOS and Android: inspection is on and bodies
 * are off unless `inspection` says otherwise.
 */
export type MacosTunnelOptions = DestinationTunnelStartOptions;

/** Options of {@link MacosClient.startRecording}. */
export interface MacosRecordingOptions {
  /** The recording's ID, `[a-z0-9][a-z0-9_-]{0,63}`. Generated when omitted; never reused. */
  recordingId?: string;
  /** Encoder quality from 5 to 10; the server default is 5. */
  quality?: number;
  /** Upload the recording to Limrun's bucket when it stops; list it with `listRecordings`. */
  persist?: PersistOption;
}

/** Where a stopped recording goes, besides the instance's own download URL. */
export interface MacosRecordingDestination {
  /** An HTTPS presigned PUT URL the instance uploads the MP4 to before the stop resolves. */
  presignedUrl?: string;
  /** A local path this client downloads the MP4 to. */
  localPath?: string;
}

/** Handlers of a live stream. `onError` fires at most once, and the stream is then closed. */
/**
 * How {@link MacosClient.launchApp} treats an app that already runs: `ForegroundIfRunning` brings
 * it to the front, `RelaunchIfRunning` stops it and starts it anew.
 */
export type MacosLaunchMode = 'ForegroundIfRunning' | 'RelaunchIfRunning';

export interface MacosLaunchAppOptions {
  /** Defaults to `ForegroundIfRunning`. */
  mode?: MacosLaunchMode;
  /** Command-line arguments for the app. */
  arguments?: string[];
  /** Environment variables for the app. */
  env?: Record<string, string>;
}

export interface MacosLaunchAppResult {
  bundleId: string;
  pid: number;
  /** False when the app already ran and was brought to the front. */
  launched: boolean;
}

export interface MacosStreamHandlers<T> {
  onEntry: (entry: T) => void;
  /** Called once the entries the instance replays on connect have all arrived. */
  onReplayed?: () => void;
  onError?: (error: Error) => void;
}

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

  /**
   * Let code in the guest reach destinations on this machine through a destination tunnel, as on
   * an iOS simulator. `localhost:port` and `IPv4:port` selectors are reached at those addresses in
   * the guest; domain selectors are resolved in the guest to addresses the tunnel serves and
   * dialed from this machine. One tunnel serves an instance at a time.
   */
  startTunnel(options: MacosTunnelOptions): Promise<DestinationTcpTunnel>;

  /** The instance's tunnel, if one is active. */
  getTunnelStatus(): Promise<DestinationTunnelStatus>;

  /** Stop the tunnel with this ID; another tunnel that replaced it keeps running. */
  stopTunnel(tunnelId: string): Promise<void>;

  /**
   * Trust a PEM-encoded CA certificate system-wide in the guest, for example the CA of an
   * intercepting proxy you record traffic with. macOS asks an administrator to confirm a new
   * trusted root, so the instance answers that dialog itself and it shows on the screen for a
   * few seconds. Adding a certificate the guest already trusts changes nothing.
   */
  addCaCertificate(pem: string): Promise<TrustedCaCertificate>;

  /**
   * Start recording the screen and return the recording's ID. Up to eight recordings may be
   * active or uploading at once.
   */
  startRecording(options?: MacosRecordingOptions): Promise<string>;

  /**
   * Stop a recording, or the latest active one when `recordingId` is omitted, and return its
   * download URL, which takes the instance token and lasts while the instance runs.
   */
  stopRecording(recordingId?: string, saveTo?: MacosRecordingDestination): Promise<string>;

  /**
   * Launch an app by bundle ID (`com.example.app`), name (`TextEdit`) or path
   * (`/Applications/Safari.app`) and bring it to the front. An app launched this way has its
   * stdout and stderr in its app log; one started any other way writes them nowhere. Arguments
   * and environment apply only when the app starts, not when it already runs.
   */
  launchApp(app: string, options?: MacosLaunchAppOptions): Promise<MacosLaunchAppResult>;

  /** Stop every process of an app. Succeeds when the app is not running. */
  terminateApp(bundleId: string): Promise<void>;

  /**
   * The last `lines` lines of an app's log: its stdout and stderr when it was started with
   * {@link launchApp}, and what it wrote to the unified log in the past hour, in time order.
   * For an app that is not Apple's, Apple's frameworks' messages are left out.
   */
  appLogTail(bundleId: string, lines: number): Promise<string>;

  /**
   * Follow an app's log, as {@link appLogTail} reads it, one line per `onEntry`. Returns a
   * function that stops it.
   */
  streamAppLog(bundleId: string, handlers: MacosStreamHandlers<string>): () => void;

  /**
   * Start capturing an app's logs. One app log capture runs at a time. With `persist`, the
   * capture is uploaded to Limrun's bucket when it stops or the instance terminates; list it
   * with `macosInstances.listAppLogs`.
   */
  startAppLogCapture(options: { bundleId: string; persist?: PersistOption }): Promise<void>;

  /** Stop the active app log capture. */
  stopAppLogCapture(): Promise<void>;

  /**
   * Start capturing the coalesced event log of clicks, scrolls and keys sent to the screen.
   * Typing is logged as a count of characters, never their content.
   */
  startEventCapture(options?: { persist?: PersistOption }): Promise<void>;

  /** Stop the active event capture. */
  stopEventCapture(): Promise<void>;

  /**
   * Start saving the running apps' performance samples. The capture always persists, kept for
   * `ttlSeconds` (server default 72h); list it with `macosInstances.listPerformanceCaptures`.
   */
  startPerformanceCapture(options?: { ttlSeconds?: number }): Promise<void>;

  /** Stop the active performance capture and upload it. */
  stopPerformanceCapture(): Promise<void>;

  /**
   * Tail the live app log capture. On connect the instance replays its recent lines, and a
   * dropped connection resumes where it left off. Returns a function that closes it.
   */
  streamAppLogCapture(handlers: MacosStreamHandlers<SessionLogLine>): () => void;

  /** Tail the live event capture, with {@link streamAppLogCapture}'s semantics. */
  streamEventCapture(handlers: MacosStreamHandlers<SessionEvent>): () => void;

  /**
   * Tail the running apps' CPU, memory, thread and disk samples, about once a second; no
   * capture is needed. On connect the instance replays its recent samples.
   */
  streamPerformance(handlers: MacosStreamHandlers<PerformanceSample>): () => void;
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
    /** List the instance's persisted session artifacts, optionally narrowed to one kind. */
    listSessionArtifacts(
      id: string,
      kind?: SessionArtifactKind,
      options?: RequestOptions,
    ): APIPromise<SessionArtifact[]>;
    /** List the instance's persisted screen recordings. */
    listRecordings(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]>;
    /** List the instance's persisted app log captures. */
    listAppLogs(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]>;
    /** List the instance's persisted event log captures. */
    listEvents(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]>;
    /** List the instance's persisted performance captures. */
    listPerformanceCaptures(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]>;
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
        const reason = directInstanceErrorReason(await response.text());
        throw new Error(`${init.method} ${path} failed: ${response.status} ${reason}`.trim());
      }
      return response;
    }

    async function post(path: string, body: unknown): Promise<void> {
      await request(path, { method: 'POST', body });
    }

    function tail<T extends { ts: number }>(
      kind: 'applogs' | 'events' | 'performance',
      handlers: MacosStreamHandlers<T>,
    ): () => void {
      return streamSessionEntries<T>({
        url: `${apiUrl}/session/${kind}/events`,
        token,
        onEntry: handlers.onEntry,
        onReplayed: handlers.onReplayed,
        onError: handlers.onError,
      });
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

      startTunnel(tunnelOptions) {
        return startDestinationTcpTunnel(
          deriveDestinationTunnelURL(apiUrl),
          token,
          destinationTunnelDialOptions(tunnelOptions, params.logLevel ?? 'info'),
        );
      },

      addCaCertificate(pem) {
        return postTrustedCaCertificate<TrustedCaCertificate>(`${apiUrl}/trusted-cas`, token, pem);
      },

      async startRecording(options) {
        if (options?.recordingId !== undefined) validateRecordingId(options.recordingId);
        const response = await request('/recordings', {
          method: 'POST',
          body: {
            ...(options?.recordingId !== undefined && { recordingId: options.recordingId }),
            ...(options?.quality !== undefined && { quality: options.quality }),
            ...persistFields(options?.persist),
          },
        });
        return ((await response.json()) as { recordingId: string }).recordingId;
      },

      async stopRecording(recordingId, saveTo = {}) {
        if (recordingId !== undefined) validateRecordingId(recordingId);
        const response = await request(
          recordingId === undefined ? '/recordings/stop' : `/recordings/${recordingId}/stop`,
          {
            method: 'POST',
            body: saveTo.presignedUrl ? { presignedUrl: saveTo.presignedUrl } : {},
          },
        );
        const stopped = ((await response.json()) as { recordingId?: string }).recordingId || recordingId;
        if (!stopped) throw new Error('the instance did not say which recording stopped');
        const downloadUrl = `${apiUrl}/files?name=${encodeURIComponent(`recording_${stopped}.mp4`)}`;
        if (saveTo.localPath) await downloadFileToLocalPath(downloadUrl, token, saveTo.localPath);
        return downloadUrl;
      },

      async launchApp(app, options) {
        const response = await request('/apps/launch', {
          method: 'POST',
          body: {
            app,
            ...(options?.mode !== undefined && { mode: options.mode }),
            ...(options?.arguments !== undefined && { arguments: options.arguments }),
            ...(options?.env !== undefined && { env: options.env }),
          },
        });
        return (await response.json()) as MacosLaunchAppResult;
      },

      async terminateApp(bundleId) {
        await request('/apps/terminate', { method: 'POST', body: { bundleId } });
      },

      async appLogTail(bundleId, lines) {
        const query = new URLSearchParams({ bundleId, lines: String(lines) });
        const response = await request(`/app-logs?${query}`, { method: 'GET' });
        return ((await response.json()) as { logs?: string }).logs ?? '';
      },

      streamAppLog(bundleId, handlers) {
        const controller = new AbortController();
        void (async () => {
          try {
            const response = await nodeProxyTransport.fetch(
              `${apiUrl}/app-logs/stream?${new URLSearchParams({ bundleId })}`,
              { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
            );
            if (!response.ok || !response.body) {
              throw new Error(
                `GET /app-logs/stream failed: ${response.status} ${await response.text()}`.trim(),
              );
            }
            for await (const event of readServerSentEvents(response.body)) handlers.onEntry(event.data);
            if (!controller.signal.aborted) throw new Error('the app log stream ended');
          } catch (error) {
            if (!controller.signal.aborted) {
              handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
            }
          }
        })();
        return () => controller.abort();
      },

      async startAppLogCapture({ bundleId, persist }) {
        if (!bundleId) throw new Error('bundleId must be a non-empty string');
        await post('/session/applogs/start', { bundleId, ...persistFields(persist) });
      },

      async stopAppLogCapture() {
        await post('/session/applogs/stop', {});
      },

      async startEventCapture(options) {
        await post('/session/events/start', { ...persistFields(options?.persist) });
      },

      async stopEventCapture() {
        await post('/session/events/stop', {});
      },

      async startPerformanceCapture(options) {
        await post('/session/performance/start', { ...ttlFields(options?.ttlSeconds) });
      },

      async stopPerformanceCapture() {
        await post('/session/performance/stop', {});
      },

      streamAppLogCapture(handlers) {
        return tail<SessionLogLine>('applogs', handlers);
      },

      streamEventCapture(handlers) {
        return tail<SessionEvent>('events', handlers);
      },

      streamPerformance(handlers) {
        return tail<PerformanceSample>('performance', handlers);
      },

      getTunnelStatus() {
        return getDestinationTunnelStatus(apiUrl, token);
      },

      async stopTunnel(tunnelId) {
        await stopDestinationTunnel(apiUrl, token, tunnelId);
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

MacosInstances.prototype.listSessionArtifacts = function (
  this: MacosInstances,
  id: string,
  kind?: SessionArtifactKind,
  options?: RequestOptions,
): APIPromise<SessionArtifact[]> {
  return this._client.get(path`/v1/macos_instances/${id}/session_artifacts`, {
    query: kind ? { kind } : undefined,
    ...options,
  });
};
MacosInstances.prototype.listRecordings = function (this: MacosInstances, id, options) {
  return this.listSessionArtifacts(id, 'recording', options);
};
MacosInstances.prototype.listAppLogs = function (this: MacosInstances, id, options) {
  return this.listSessionArtifacts(id, 'appLog', options);
};
MacosInstances.prototype.listEvents = function (this: MacosInstances, id, options) {
  return this.listSessionArtifacts(id, 'eventLog', options);
};
MacosInstances.prototype.listPerformanceCaptures = function (this: MacosInstances, id, options) {
  return this.listSessionArtifacts(id, 'performance', options);
};

/** validateRecordingId refuses an ID the instance would refuse, before anything is sent. */
function validateRecordingId(recordingId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(recordingId)) {
    throw new Error('recordingId must match ^[a-z0-9][a-z0-9_-]{0,63}$');
  }
}

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
