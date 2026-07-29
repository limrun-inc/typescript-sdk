/**
 * Client for executing commands on limbuild server with streaming output.
 *
 * The interface is designed to be similar to Node.js's child_process.spawn()
 * for familiarity and ease of extension.
 */

import { createEventSource, type EventSourceClient, type EventSourceMessage } from 'eventsource-client';
import { nodeProxyTransport } from './internal/proxy-transport';
import { directInstanceHttpError } from './internal/direct-instance-errors';
import type { Fetch } from './internal/builtin-types';

// =============================================================================
// Types
// =============================================================================

export type ExecRequest = XcodeBuildExecRequest | GradleBuildExecRequest | RunExecRequest;

export type XcodeBuildExecRequest = {
  command: 'xcodebuild';
  xcodebuild?: {
    workspace?: string;
    project?: string;
    scheme?: string;
    sdk?: 'iphonesimulator' | 'iphoneos' | 'watchsimulator' | 'watchos';
    configuration?: 'Debug' | 'Release';
  };
  xcodegen?: {
    spec?: string;
    project?: string;
    projectRoot?: string;
  };
  reactNative?: {
    expoAppDir?: string;
    devServerURL?: string;
  };
  signing?: {
    certificateP12Base64?: string;
    certificatePassword?: string;
    provisioningProfileBase64?: string;
  };
  /** Wire name retained for compatibility with the limbuild exec API. */
  testflight?: AppStoreUploadConfig;
  buildSettings?: Record<string, string>;
  gitInit?: boolean;
  signedUploadUrl?: string;
  webhook?: WebhookConfig;
  additionalMetadata?: {
    signedDownloadUrl?: string;
  };
};

/**
 * Build-finish webhook: limbuild POSTs a JSON payload to `url` once the build
 * reaches a terminal state (SUCCEEDED, FAILED, or CANCELLED), carrying the
 * result (execId, status, exitCode, timing), the instance's identity with a
 * Limrun Console debug link, and a presigned URL for the persisted build log
 * when log persistence is configured. Delivery is best-effort with bounded
 * retries; a webhook failure never fails the build.
 */
export type WebhookConfig = {
  /**
   * HTTPS URL the payload is POSTed to. Must be a public DNS host;
   * IP-literal, private, and cluster-internal targets are rejected by the
   * server with HTTP 400 at build request time.
   */
  url: string;
  /**
   * Headers set verbatim on the callback request (e.g. an Authorization
   * bearer token so your endpoint can authenticate the call). At most 16
   * headers; hop-by-hop and message-framing headers (Host, Content-Length,
   * Transfer-Encoding, Connection) are rejected.
   */
  headers?: Record<string, string>;
};

/** Android ABIs the gradle daemon accepts; 'all' keeps the project's own configuration. */
export type GradleAndroidABI = 'armeabi-v7a' | 'arm64-v8a' | 'x86' | 'x86_64' | 'all';

/**
 * React Native / Expo tuning for gradle builds. The server detects Expo
 * managed-workflow projects automatically when the workspace has no
 * Gradle root; setting this forces the React Native pipeline (dependency
 * install, expo prebuild) and is an error for projects with no detected
 * Expo app.
 */
export type GradleReactNativeConfig = {
  /** Relative path to the Expo app directory in a monorepo. Omit to auto-detect. */
  expoAppDir?: string;
  /**
   * Android ABIs to build. The server defaults to x86_64 (what Limrun
   * Android instances run) except for release and bundle tasks, which
   * keep the project's own ABI configuration; pass ['all'] to always
   * keep it.
   */
  architectures?: GradleAndroidABI[];
};

/**
 * Release signing config injected via Gradle's android.injected.signing.*
 * properties. Presence changes the server's default task to bundleRelease
 * and extends artifact discovery to build/outputs/bundle. The keystore and
 * passwords live only for the build's duration and never appear in
 * streamed output.
 */
export type GradleSigningConfig = {
  /** Base64-encoded PKCS12 or JKS upload keystore. */
  keystoreBase64: string;
  keystorePassword: string;
  keyAlias: string;
  keyPassword: string;
};

export type GradleBuildExecRequest = {
  command: 'gradlebuild';
  /**
   * Gradle tasks to run. Omit for the server default (assembleDebug, or
   * bundleRelease when signing is set).
   */
  tasks?: string[];
  /** Relative path to the Gradle root when auto-discovery is ambiguous. */
  projectPath?: string;
  reactNative?: GradleReactNativeConfig;
  signing?: GradleSigningConfig;
  playstore?: GradlePlaystoreConfig;
  signedUploadUrl?: string;
  webhook?: WebhookConfig;
  additionalMetadata?: {
    signedDownloadUrl?: string;
  };
};

/**
 * Publish the built AAB to a Google Play track after a successful build.
 * Requires signing. Exactly one of accessToken or serviceAccountJsonBase64
 * must be set; the credential is held in memory for the build duration
 * only. Progress and failure causes stream as `playstore` SSE events.
 */
export type GradlePlaystoreConfig = {
  /** OAuth bearer token carrying the androidpublisher scope. */
  accessToken?: string;
  /** Base64-encoded service-account JSON key invited in Play Console. */
  serviceAccountJsonBase64?: string;
  /**
   * Play track ID, passed to Google verbatim: internal (default), alpha,
   * beta, production, or a custom closed-testing track. Publishing
   * replaces the track's existing releases, including an in-progress
   * staged rollout on that track.
   */
  track?: string;
  /**
   * completed (default) makes the release live on the track; draft
   * commits it without rollout. Publishing to the production track
   * requires setting it explicitly.
   */
  releaseStatus?: 'draft' | 'completed';
  /** Package name to publish under. Omit to read it from the built AAB. */
  packageName?: string;
  /**
   * Set the versionCode to one more than the highest already known to
   * Google Play (1 for an app with no artifacts), so repeat publishes
   * never collide. Resolved with the publish credential before the build
   * and stamped into the workspace copy: android.versionCode in the Expo
   * config (requires a static app.json), or the single literal
   * versionCode in a native project's conventional app/ module build
   * script (computed or flavor-split versionCodes are rejected at
   * request time).
   */
  autoIncrementVersionCode?: boolean;
};

export type RunExecRequest = {
  command: 'run';
  commandLine: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
};

export type ExecOptions = {
  apiUrl: string;
  token: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
};

export type ExecResult = {
  exitCode: number;
  execId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  signedDownloadUrl?: string;
  /**
   * Last App Store Connect upload state streamed by the server. Absent when
   * the build ran without an App Store upload, or when the server predates
   * the feature.
   */
  appstore?: AppStoreEvent;
  /**
   * Last Play Store state streamed by the server. Absent when the build ran
   * without a playstore request, or when the server predates the feature.
   */
  playstore?: PlaystoreEvent;
  /**
   * True when the client gave up waiting for the build's event stream. The
   * exit code is fabricated in that case; the remote build may still be
   * running and may yet succeed.
   */
  timedOut?: boolean;
};

export type ExecLogEvent = {
  id?: string;
  type: string;
  data: string;
};

export type ExecLogOptions = {
  /** Keep streaming after replaying buffered events. Defaults to false. */
  follow?: boolean;
  /** Called for each replayed or live event in wire order. */
  onEvent?: (event: ExecLogEvent) => void;
  signal?: AbortSignal;
};

export type ExecLogResult = {
  /** The requested exec ID. May be "active" when the daemon resolved that alias. */
  execId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  exitCode?: number;
};

export type AppStoreEvent = {
  /** 'unknown' means an App Store upload event arrived but its payload was unreadable. */
  state: 'uploading' | 'processing' | 'accepted' | 'failed' | 'unknown';
  uploadId?: string;
  buildId?: string;
};

export type PlaystoreEvent = {
  /** 'unknown' means a playstore event arrived but its payload was unreadable. */
  state: 'uploading' | 'accepted' | 'failed' | 'unknown';
  versionCode?: number;
  track?: string;
  /** Machine-readable failure code; present only on failed. */
  code?: string;
  message?: string;
};

export type AppStoreUploadConfig = {
  /** App Store Connect API key ID, e.g. 2X9R4HXF34. */
  apiKeyId: string;
  /** Issuer ID for team API keys. Omit for individual API keys. */
  apiIssuerId?: string;
  /** Base64-encoded content of the .p8 private key file. */
  apiPrivateKeyBase64: string;
  /**
   * How long the server watches for App Store Connect's processing verdict
   * after the upload. A FAILED verdict within the window fails the build;
   * expiry without a verdict succeeds with the build still processing on
   * Apple's side. Defaults to 0, which returns as soon as the upload
   * commits without watching the verdict (processing routinely takes many
   * minutes).
   */
  waitTimeoutSeconds?: number;
};

type DataListener = (chunk: string) => void;
type CloseListener = () => void;
type ExitListener = (code: number) => void;

/**
 * A Readable-like stream interface, similar to Node.js stream.Readable.
 * Emits 'data' for each chunk and 'close' when the stream ends.
 */
export class ReadableStream {
  private dataListeners: DataListener[] = [];
  private closeListeners: CloseListener[] = [];
  private closed = false;

  on(event: 'data', listener: DataListener): this;
  on(event: 'close', listener: CloseListener): this;
  on(event: 'data' | 'close', listener: DataListener | CloseListener): this {
    if (event === 'data') {
      this.dataListeners.push(listener as DataListener);
    } else if (event === 'close') {
      this.closeListeners.push(listener as CloseListener);
    }
    return this;
  }

  /** @internal */
  emit(event: 'data', chunk: string): void;
  emit(event: 'close'): void;
  emit(event: 'data' | 'close', arg?: string): void {
    if (event === 'data' && typeof arg === 'string') {
      for (const l of this.dataListeners) l(arg);
    } else if (event === 'close' && !this.closed) {
      this.closed = true;
      for (const l of this.closeListeners) l();
    }
  }
}

type FollowExecEventStreamOptions<TResult> = {
  eventsUrl: string;
  token: string;
  signal?: AbortSignal;
  operation: string;
  abortError: () => Error;
  onEvent: (event: ExecLogEvent) => TResult | undefined;
  /** Return an error to stop; return undefined to let EventSource reconnect. */
  onDisconnect: () => Error | undefined;
};

/**
 * Shared transport for replaying and following exec SSE. It owns HTTP error
 * handling, message normalization, abort cleanup, callback failures, and
 * connection settlement; callers only route events and define completion.
 */
function followExecEventStream<TResult>(options: FollowExecEventStreamOptions<TResult>): {
  connection: EventSourceClient | null;
  result: Promise<TResult>;
} {
  let connection: EventSourceClient | null = null;
  let settled = false;
  let onAbort = () => {};

  const result = new Promise<TResult>((resolve, reject) => {
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      connection?.close();
      connection = null;
    };
    const settleResolve = (value: TResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    onAbort = () => settleReject(options.abortError());

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    const checkedFetch: Fetch = async (input, init) => {
      let response: Response;
      try {
        response = await nodeProxyTransport.fetch(input, init);
      } catch (err) {
        settleReject(err);
        throw err;
      }
      if (!response.ok) {
        const text = await response.text();
        const err = directInstanceHttpError(options.operation, response.status, text, response.headers);
        settleReject(err);
        throw err;
      }
      return response;
    };

    try {
      connection = createEventSource({
        url: options.eventsUrl,
        fetch: checkedFetch,
        headers: { Authorization: `Bearer ${options.token}` },
        onMessage: (message: EventSourceMessage) => {
          if (settled) return;
          try {
            const event: ExecLogEvent = {
              ...(message.id && { id: message.id }),
              type: message.event || 'message',
              data: typeof message.data === 'string' ? message.data : String(message.data ?? ''),
            };
            const value = options.onEvent(event);
            if (value !== undefined) {
              settleResolve(value);
            }
          } catch (err) {
            settleReject(err);
          }
        },
        onDisconnect: () => {
          if (settled) return;
          const err = options.onDisconnect();
          if (err) settleReject(err);
        },
      });
      if (settled) {
        connection.close();
        connection = null;
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
    } catch (err) {
      settleReject(err);
    }
  });

  return { connection, result };
}

/**
 * A ChildProcess-like object similar to Node.js's ChildProcess.
 *
 * Implements PromiseLike so it can be awaited directly.
 *
 * @example
 * // Stream-based (like Node.js spawn)
 * const proc = exec({ command: 'xcodebuild' }, options);
 * proc.command.on('data', (chunk) => console.log('[command]', chunk));
 * proc.stdout.on('data', (chunk) => process.stdout.write(chunk));
 * proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
 * proc.on('exit', (code) => console.log(`Exited with code ${code}`));
 *
 * // Promise-based (can be awaited)
 * const { exitCode, status } = await proc;
 */
export class ExecChildProcess implements PromiseLike<ExecResult> {
  /** Command stream - emits the executed command and then closes */
  readonly command = new ReadableStream();

  /** Stdout stream - emits 'data' and 'close' events */
  readonly stdout = new ReadableStream();

  /** Stderr stream - emits 'data' and 'close' events */
  readonly stderr = new ReadableStream();

  /** The remote process/build identifier (similar to pid in Node.js) */
  execId: string | undefined;

  private readonly resultPromise: Promise<ExecResult>;
  private readonly startedPromise: Promise<string>;
  private resolveStarted!: (execId: string) => void;
  private rejectStarted!: (reason: unknown) => void;
  private readonly exitListeners: ExitListener[] = [];
  private abortController = new AbortController();
  private sseConnection: EventSourceClient | null = null;
  private killed = false;
  private detached = false;
  private appStoreEvent: AppStoreEvent | null = null;
  private playstoreEvent: PlaystoreEvent | null = null;
  private readonly options: ExecOptions;
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

  constructor(request: ExecRequest | Promise<ExecRequest>, options: ExecOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.startedPromise = new Promise<string>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    // Most callers await the terminal result and never call detach(); keep the
    // dormant startup promise from becoming an unhandled rejection for them.
    void this.startedPromise.catch(() => {});
    if (request instanceof Promise) {
      this.resultPromise = request.then((r) => this.run(r));
    } else {
      this.resultPromise = this.run(request);
    }
    // Fail detach() as well when request preparation or POST /exec fails.
    void this.resultPromise.catch((err) => this.rejectStarted(err));
  }

  /** Implement PromiseLike so this object can be awaited */
  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?: ((value: ExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.resultPromise.then(onfulfilled, onrejected);
  }

  /** Catch errors */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<ExecResult | TResult> {
    return this.resultPromise.catch(onrejected);
  }

  /** Finally handler */
  finally(onfinally?: (() => void) | null): Promise<ExecResult> {
    return this.resultPromise.finally(onfinally);
  }

  /** Listen for process events */
  on(event: 'exit', listener: ExitListener): this {
    if (event === 'exit') {
      this.exitListeners.push(listener);
    }
    return this;
  }

  /**
   * Return once the remote execution has been accepted, without opening its
   * event stream or waiting for completion. Call immediately after creating
   * the process. The remote execution keeps running; use a build-finish
   * webhook or the build-log APIs to observe its terminal result.
   */
  detach(): Promise<string> {
    this.detached = true;
    // The caller observes startup failures through startedPromise. Mark the
    // completion promise handled because detached callers intentionally never
    // await it.
    void this.resultPromise.catch(() => {});
    return this.startedPromise;
  }

  /** Send a signal to terminate the process */
  async kill(): Promise<void> {
    this.killed = true;
    this.abortController.abort();
    if (this.sseConnection) {
      this.sseConnection.close();
      this.sseConnection = null;
    }
    if (!this.execId) {
      this.log('warn', 'Failed to cancel execution: execId is not set');
      return;
    }
    try {
      await nodeProxyTransport.fetch(`${this.options.apiUrl}/exec/${this.execId}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
        },
      });
      this.log('info', 'Execution cancelled');
    } catch (err) {
      this.log('warn', `Failed to cancel execution: ${err}`);
    }
  }

  private async run(request: ExecRequest): Promise<ExecResult> {
    const { log } = this;
    const { apiUrl, token } = this.options;

    // 1. Trigger the build via POST /exec.
    // additionalMetadata is a client-only carrier (no daemon reads it; it is
    // spread into ExecResult below so callers can surface the download URL), so
    // it is stripped from the wire body: the daemon OpenAPI schemas do not
    // declare it, and sending it would 400 under strict request validation.
    // The 'run' command has no artifact upload and never carries it.
    const wireRequest = { ...request };
    if ('additionalMetadata' in wireRequest) {
      delete wireRequest.additionalMetadata;
    }
    let execRes: Response;
    try {
      execRes = await nodeProxyTransport.fetch(`${apiUrl}/exec`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(wireRequest),
        signal: this.abortController.signal,
      });
    } catch (err) {
      if (this.killed) {
        this.rejectStarted(new Error('Execution cancelled before it started'));
        this.command.emit('close');
        this.stdout.emit('close');
        this.stderr.emit('close');
        for (const listener of this.exitListeners) {
          listener(-1);
        }
        return { exitCode: -1, execId: '', status: 'CANCELLED' };
      }
      throw err;
    }

    if (!execRes.ok) {
      const text = await execRes.text();
      let message = text;
      try {
        // The daemon returns an APIError JSON body; surface its message
        // instead of the raw escaped JSON.
        message = (JSON.parse(text) as { message?: string }).message || text;
      } catch {
        // Not JSON; keep the raw body.
      }
      throw new Error(`exec failed: ${execRes.status} ${message}`);
    }

    const execData = (await execRes.json()) as { execId: string };
    this.execId = execData.execId;
    log('debug', `Execution started: ${this.execId}`);
    this.resolveStarted(this.execId);

    if (this.detached) {
      // An unresolved promise holds no Node.js event-loop resources. Keeping
      // the terminal result pending accurately reflects that this client
      // deliberately stopped observing the remote execution.
      this.command.emit('close');
      this.stdout.emit('close');
      this.stderr.emit('close');
      return new Promise<ExecResult>(() => {});
    }

    // 2. Stream logs via SSE and wait for exit code
    const eventsUrl = `${apiUrl}/exec/${this.execId}/events`;

    // 1 hour max for the build itself; a TestFlight request extends the
    // budget by its server-side verdict watch plus upload headroom so a long
    // build is not force-failed client-side while the server still succeeds.
    let timeoutMs = 3600 * 1000;
    if (request.command === 'xcodebuild' && request.testflight) {
      timeoutMs += (Math.max(0, request.testflight.waitTimeoutSeconds ?? 0) + 900) * 1000;
    } else if (request.command === 'run') {
      timeoutMs = (Math.max(1, request.timeoutSeconds ?? 3600) + 60) * 1000;
    }
    let exitCode: number;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      exitCode = await Promise.race([
        this.connectSSE(eventsUrl),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('SSE timeout')), timeoutMs);
        }),
      ]);
    } catch {
      if (this.killed) {
        log('debug', 'Execution killed');
        exitCode = -1;
      } else {
        // The client stopped waiting; the remote build may still be running.
        // The fabricated exit code must not read as a build failure.
        log('warn', 'SSE completion timeout');
        exitCode = 1;
        timedOut = true;
      }
    } finally {
      clearTimeout(timeoutId);
      if (this.sseConnection) {
        this.sseConnection.close();
        this.sseConnection = null;
      }
    }

    // Emit close events on streams
    this.command.emit('close');
    this.stdout.emit('close');
    this.stderr.emit('close');

    // Emit exit event
    for (const listener of this.exitListeners) {
      listener(exitCode);
    }

    // Determine status from exit code
    const status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' =
      exitCode === 0 ? 'SUCCEEDED'
      : exitCode === -1 ? 'CANCELLED'
      : 'FAILED';

    const result: ExecResult = {
      exitCode,
      execId: this.execId!,
      status,
      ...('additionalMetadata' in request ? request.additionalMetadata ?? {} : {}),
      ...(this.appStoreEvent ? { appstore: this.appStoreEvent } : {}),
      ...(this.playstoreEvent ? { playstore: this.playstoreEvent } : {}),
      ...(timedOut ? { timedOut } : {}),
    };

    this.log('debug', `Execution finished: ${result.status} (exit ${result.exitCode})`);
    return result;
  }

  /**
   * Opens an SSE connection and routes streamed events to the exposed command/stdout/stderr streams.
   * Resolves with the exit code when an 'exitCode' event arrives.
   * Rejects when the abort signal fires (kill or cleanup).
   */
  private connectSSE(eventsUrl: string): Promise<number> {
    const stream = followExecEventStream<number>({
      eventsUrl,
      token: this.options.token,
      signal: this.abortController.signal,
      operation: 'GET exec events',
      abortError: () => new Error('killed'),
      onEvent: (event) => {
        const { data } = event;
        if (event.type === 'command') {
          this.command.emit('data', data);
        } else if (event.type === 'stdout') {
          this.stdout.emit('data', data);
        } else if (event.type === 'stderr') {
          this.stderr.emit('data', data);
        } else if (event.type === 'testflight') {
          try {
            this.appStoreEvent = JSON.parse(data) as AppStoreEvent;
          } catch {
            // The wire event itself proves the server ran the App Store upload,
            // so never let a payload glitch look like a missing feature.
            this.appStoreEvent = { state: 'unknown' };
            this.log('warn', `SSE testflight event has invalid data: ${data}`);
          }
        } else if (event.type === 'playstore') {
          try {
            this.playstoreEvent = JSON.parse(data) as PlaystoreEvent;
          } catch {
            // Same contract as the App Store upload event: its presence proves the server
            // ran the Play Store step, so a payload glitch must not
            // read as a missing feature.
            this.playstoreEvent = { state: 'unknown' };
            this.log('warn', `SSE playstore event has invalid data: ${data}`);
          }
        } else if (event.type === 'exitCode') {
          const exitCode = Number.parseInt(data, 10);
          if (Number.isNaN(exitCode)) {
            this.log('warn', `SSE exitCode event has invalid data: ${data}`);
            return undefined;
          }
          this.log('debug', `Execution completed via SSE: exitCode=${exitCode}`);
          return exitCode;
        }
        return undefined;
      },
      onDisconnect: () => {
        if (!this.killed) {
          this.log('warn', 'SSE disconnected');
        }
        return undefined;
      },
    });
    this.sseConnection = stream.connection;
    return stream.result.catch((err) => {
      if (!this.killed) {
        this.log('warn', `SSE setup failed: ${err}`);
      }
      throw err;
    });
  }
}

/**
 * Replay logs for an existing execution, optionally following it to completion.
 * Snapshot mode uses a finite SSE response; follow mode consumes the same
 * replayable stream until its terminal exitCode event.
 */
export async function observeExecLogs(
  execId: string,
  options: ExecOptions & ExecLogOptions,
): Promise<ExecLogResult> {
  if (!execId.trim()) {
    throw new Error('execId must not be empty');
  }
  const follow = options.follow ?? false;
  const eventsUrl = new URL(
    `${options.apiUrl.replace(/\/+$/, '')}/exec/${encodeURIComponent(execId)}/events`,
  );
  eventsUrl.searchParams.set('follow', String(follow));

  if (!follow) {
    const response = await nodeProxyTransport.fetch(eventsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${options.token}` },
      ...(options.signal && { signal: options.signal }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw directInstanceHttpError('GET exec logs', response.status, text, response.headers);
    }
    const events = parseSSE(await response.text());
    let exitCode: number | undefined;
    let resolvedExecId = execId;
    for (const event of events) {
      resolvedExecId = execIdFromMeta(event, resolvedExecId);
      options.onEvent?.(event);
      if (event.type === 'exitCode') {
        exitCode = parseExitCode(event.data);
      }
    }
    return buildExecLogResult(resolvedExecId, exitCode);
  }

  let resolvedExecId = execId;
  const stream = followExecEventStream<ExecLogResult>({
    eventsUrl: eventsUrl.toString(),
    token: options.token,
    ...(options.signal && { signal: options.signal }),
    operation: 'GET exec logs',
    abortError: () => new Error(`exec log stream for ${execId} was aborted`),
    onEvent: (event) => {
      resolvedExecId = execIdFromMeta(event, resolvedExecId);
      options.onEvent?.(event);
      if (event.type === 'exitCode') {
        return buildExecLogResult(resolvedExecId, parseExitCode(event.data));
      }
      return undefined;
    },
    onDisconnect: () => new Error(`exec log stream for ${execId} ended without a terminal event`),
  });
  return stream.result;
}

function parseSSE(body: string): ExecLogEvent[] {
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const events: ExecLogEvent[] = [];
  for (const block of normalized.split('\n\n')) {
    if (!block.trim()) continue;
    let id: string | undefined;
    let type = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) {
        id = line.slice(3).trimStart();
      } else if (line.startsWith('event:')) {
        type = line.slice(6).trimStart();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (data.length > 0 || type !== 'message' || id !== undefined) {
      events.push({ ...(id !== undefined && { id }), type, data: data.join('\n') });
    }
  }
  return events;
}

function parseExitCode(data: string): number {
  const exitCode = Number.parseInt(data, 10);
  if (Number.isNaN(exitCode)) {
    throw new Error(`invalid exec exit code: ${data}`);
  }
  return exitCode;
}

function execIdFromMeta(event: ExecLogEvent, fallback: string): string {
  if (event.type !== 'meta') return fallback;
  try {
    const meta = JSON.parse(event.data) as { id?: unknown };
    return typeof meta.id === 'string' && meta.id ? meta.id : fallback;
  } catch {
    return fallback;
  }
}

function buildExecLogResult(execId: string, exitCode: number | undefined): ExecLogResult {
  if (exitCode === undefined) {
    return { execId, status: 'RUNNING' };
  }
  return {
    execId,
    exitCode,
    status:
      exitCode === 0 ? 'SUCCEEDED'
      : exitCode === -1 ? 'CANCELLED'
      : 'FAILED',
  };
}

/**
 * Execute a command on the limbuild server.
 * Returns a ChildProcess-like object with stdout/stderr streams.
 *
 * @example
 * const proc = exec({ command: 'xcodebuild' }, { apiUrl: '...', token: '...' });
 *
 * // Stream output
 * proc.command.on('data', (chunk) => console.log('[command]', chunk));
 * proc.stdout.on('data', (chunk) => console.log('[stdout]', chunk));
 * proc.stderr.on('data', (chunk) => console.error('[stderr]', chunk));
 *
 * // Wait for completion
 * const { exitCode, status } = await proc;
 */
export function exec(request: ExecRequest | Promise<ExecRequest>, options: ExecOptions): ExecChildProcess {
  return new ExecChildProcess(request, options);
}
