/**
 * Client for executing commands on limbuild server with streaming output.
 *
 * The interface is designed to be similar to Node.js's child_process.spawn()
 * for familiarity and ease of extension.
 */

import { createEventSource, type EventSourceClient, type EventSourceMessage } from 'eventsource-client';
import { nodeProxyTransport } from './internal/proxy-transport';
import { sseFetch } from './internal/sse-fetch';
import type { Fetch } from './internal/builtin-types';

/**
 * Give-up policy for the exec event stream. The EventSource reconnects
 * forever on its own, so a dead exec (deleted instance, expired record)
 * would otherwise retry until the one-hour completion timeout. Proof of
 * life resets the clock: a delivered event, or a clean connection that
 * stays open healthyConnectionMs (long compiles stream nothing for
 * minutes while intermediaries kill idle connections). The window is
 * wide enough to ride out real transient outages (an ingress redeploy, a
 * VPN reconnect); tightening it trades outage tolerance for faster
 * dead-exec detection. It is measured in time, not attempts: the server
 * steers the retry delay through SSE `retry:` frames, so an attempt
 * count would put the give-up horizon under remote control.
 *
 * @internal Mutable for tests only.
 */
export const sseStreamPolicy = {
  healthyConnectionMs: 15_000,
  giveUpAfterMs: 300_000,
};

/** The event stream kept failing past the give-up window; remote state unknown. */
export class ExecStreamLostError extends Error {}

/** The server closed the event stream for good (HTTP 204). */
export class ExecStreamClosedError extends Error {}

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
    artifactName?: string;
  };
  xcodegen?: {
    spec?: string;
    project?: string;
    projectRoot?: string;
  };
  reactNative?: {
    expoAppDir?: string;
    devServerURL?: string;
    expoForcePrebuild?: boolean;
  };
  signing?: {
    certificateP12Base64?: string;
    certificatePassword?: string;
    /** One profile per embedded bundle. */
    provisioningProfilesBase64?: string[];
  };
  cloudSigning?: {
    method: 'app-store-connect' | 'release-testing' | 'debugging';
    teamId: string;
    apiKeyId: string;
    apiIssuerId: string;
    apiPrivateKeyBase64: string;
  };
  /** Wire name retained for compatibility with the limbuild exec API. */
  testflight?: AppStoreUploadConfig;
  buildSettings?: Record<string, string>;
  /**
   * Ordered KEY=VALUE entries added to the environment of every build
   * pipeline command (installs, prebuild, pod install, xcodebuild).
   * Server-managed variables (PATH, HOME, ...) cannot be overridden.
   */
  env?: string[];
  gitInit?: boolean;
  /** Stream raw xcodebuild output instead of piping it through xcbeautify. */
  disableXcbeautify?: boolean;
  signedUploadUrl?: string;
  /**
   * ID of the Limrun asset signedUploadUrl targets, when it was minted from
   * one. Lets limbuild record the built app's metadata (title, bundle
   * identifier, versions, deep link scheme, icon) on the asset, which the
   * registry's OTA install flow reads. Older limbuild servers ignore it.
   */
  assetId?: string;
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
  /**
   * Ordered KEY=VALUE entries added to the command's environment.
   * Server-managed variables (PATH, HOME, ...) cannot be overridden.
   */
  env?: string[];
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
  /**
   * Why the client gave up, present exactly when timedOut is true.
   * 'timeout' is the completion budget expiring on a live stream;
   * 'stream-lost' means the event stream kept failing (the execution may
   * no longer exist); 'stream-closed' means the server ended the stream
   * for good.
   */
  incomplete?: { reason: 'timeout' | 'stream-lost' | 'stream-closed'; message: string };
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
  /**
   * Set CFBundleVersion to one more than the highest build already known to
   * App Store Connect before upload.
   */
  autoIncrementBuildNumber?: boolean;
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
  // Start of the stream's current unbroken failure streak, 0 while
  // healthy. run() reads it to classify a completion timeout that
  // expired while the stream was already dead.
  private streamDeadSince = 0;
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
    let incomplete: ExecResult['incomplete'];
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      exitCode = await Promise.race([
        this.connectSSE(eventsUrl),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('SSE completion timeout')), timeoutMs);
        }),
      ]);
    } catch (err) {
      if (this.killed) {
        log('debug', 'Execution killed');
        exitCode = -1;
      } else {
        // The client stopped waiting; the fabricated exit code must not
        // read as a build failure. The structured reason lets callers give
        // the right advice: a dead stream means the execution may be gone,
        // while a genuine timeout means it may still be running. A budget
        // that expires mid-failure-streak (short run timeouts undercut the
        // stream's own give-up window) counts as a stream problem too.
        let message = err instanceof Error ? err.message : String(err);
        const streakMs = this.streamDeadSince > 0 ? Date.now() - this.streamDeadSince : 0;
        let reason: NonNullable<ExecResult['incomplete']>['reason'] =
          err instanceof ExecStreamClosedError ? 'stream-closed'
          : err instanceof ExecStreamLostError ? 'stream-lost'
          : 'timeout';
        if (reason === 'timeout' && streakMs > 0) {
          reason = 'stream-lost';
          message =
            `the completion budget expired while the event stream had already been failing ` +
            `for ${Math.round(streakMs / 1000)}s; the execution may no longer exist ` +
            `(instance deleted or record expired)`;
        }
        incomplete = { reason, message };
        log('warn', message);
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
      ...(incomplete ? { incomplete } : {}),
    };

    this.log('debug', `Execution finished: ${result.status} (exit ${result.exitCode})`);
    return result;
  }

  /**
   * Opens an SSE connection and routes streamed events to the exposed command/stdout/stderr streams.
   * Resolves with the exit code when an 'exitCode' event arrives.
   * Rejects when the abort signal fires (kill or cleanup), when the server
   * closes the stream for good, or when the give-up clock runs out.
   */
  private connectSSE(eventsUrl: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const signal = this.abortController.signal;
      if (signal.aborted) {
        reject(new Error('killed'));
        return;
      }

      // Settle-once pair. Both paths close the source: the EventSource
      // reconnects on its own otherwise, even after the promise is done.
      let settled = false;
      let connectedAt = 0;
      let lastCycleAt = 0;
      let lastCycleMono = 0;
      let proofOfLifeThisCycle = false;
      let cleanResponseThisCycle = false;
      let lastStreamError: Error | undefined;
      const cleanup = () => {
        eventSource.close();
        signal.removeEventListener('abort', onAbort);
      };
      const succeed = (exitCode: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(exitCode);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(new Error('killed'));

      // Stream health is judged at the fetch surface, where the response
      // status is visible; the library fires onConnect for error responses
      // too, so an error page held open must not read as a healthy
      // connection. An HTTP 204 makes the EventSource close for good
      // without reporting anything, so it must fail here. A rejected fetch
      // never reaches onDisconnect (the hazard sseFetch exists for):
      // capture it for the give-up message and let the clock decide, so
      // one transient refusal does not kill a live build.
      const fetchWithStreamPolicy: Fetch = async (input, init) => {
        const response = await nodeProxyTransport.fetch(input, init);
        if (response.status === 204) {
          fail(new ExecStreamClosedError(`event stream to ${eventsUrl} was closed by the server (HTTP 204)`));
        } else if (!response.ok) {
          lastStreamError = new Error(`server answered HTTP ${response.status}`);
        }
        cleanResponseThisCycle = response.ok;
        return response;
      };

      const eventSource = createEventSource({
        url: eventsUrl,
        fetch: sseFetch(fetchWithStreamPolicy, (err) => {
          lastStreamError = err instanceof Error ? err : new Error(String(err));
        }),
        headers: { Authorization: `Bearer ${this.options.token}` },
        onConnect: () => {
          connectedAt = Date.now();
        },
        // Comments count as proof of life, so a server-side keepalive
        // works without a client change (onMessage never sees them).
        onComment: () => {
          proofOfLifeThisCycle = true;
        },
        // Fires once per broken cycle, before the retry timer is armed, on
        // both failure paths (request rejected, stream ended). This is
        // where the give-up clock runs.
        onScheduleReconnect: () => {
          if (settled || this.killed) {
            return;
          }
          const now = Date.now();
          const mono = performance.now();
          const livedMs = connectedAt > 0 ? now - connectedAt : 0;
          connectedAt = 0;
          // Date.now() is wall clock: a laptop waking from sleep (or a
          // clock step) would arrive with the whole window already
          // "elapsed" and fail on its first attempt. Sleep is the wall
          // clock advancing while the monotonic clock stands still; a
          // large drift between the two restarts the streak. Long server
          // retry delays and hanging connects advance both clocks equally
          // and keep counting.
          if (this.streamDeadSince > 0 && lastCycleAt > 0) {
            const wallGapMs = now - lastCycleAt;
            const monoGapMs = mono - lastCycleMono;
            if (wallGapMs - monoGapMs > 30_000) {
              this.streamDeadSince = now;
            }
          }
          lastCycleAt = now;
          lastCycleMono = mono;
          const healthy =
            proofOfLifeThisCycle ||
            (cleanResponseThisCycle && livedMs >= sseStreamPolicy.healthyConnectionMs);
          proofOfLifeThisCycle = false;
          cleanResponseThisCycle = false;
          if (healthy) {
            this.streamDeadSince = 0;
            lastStreamError = undefined;
            return;
          }
          if (this.streamDeadSince === 0) {
            this.streamDeadSince = now;
            this.log('warn', 'SSE disconnected; reconnecting');
            return;
          }
          if (now - this.streamDeadSince >= sseStreamPolicy.giveUpAfterMs) {
            const seconds = Math.round((now - this.streamDeadSince) / 1000);
            const cause = lastStreamError ? `; last error: ${lastStreamError.message}` : '';
            fail(
              new ExecStreamLostError(
                `event stream to ${eventsUrl} kept failing for ${seconds}s without delivering events${cause}; ` +
                  'the execution may no longer exist (instance deleted or record expired)',
              ),
            );
          }
        },
        onMessage: (message: EventSourceMessage) => {
          this.streamDeadSince = 0;
          proofOfLifeThisCycle = true;
          lastStreamError = undefined;
          const data = typeof message.data === 'string' ? message.data : String(message.data ?? '');
          const eventType = message.event;
          if (eventType === 'command') {
            this.command.emit('data', data);
          } else if (eventType === 'stdout') {
            this.stdout.emit('data', data);
          } else if (eventType === 'stderr') {
            this.stderr.emit('data', data);
          } else if (eventType === 'testflight') {
            try {
              this.appStoreEvent = JSON.parse(data) as AppStoreEvent;
            } catch {
              // The wire event itself proves the server ran the App Store upload,
              // so never let a payload glitch look like a missing feature.
              this.appStoreEvent = { state: 'unknown' };
              this.log('warn', `SSE testflight event has invalid data: ${data}`);
            }
          } else if (eventType === 'playstore') {
            try {
              this.playstoreEvent = JSON.parse(data) as PlaystoreEvent;
            } catch {
              // Same contract as the App Store upload event: its presence proves the server
              // ran the Play Store step, so a payload glitch must not
              // read as a missing feature.
              this.playstoreEvent = { state: 'unknown' };
              this.log('warn', `SSE playstore event has invalid data: ${data}`);
            }
          } else if (eventType === 'exitCode') {
            const exitCode = parseInt(data, 10);
            if (Number.isNaN(exitCode)) {
              this.log('warn', `SSE exitCode event has invalid data: ${data}`);
              return;
            }
            this.log('debug', `Execution completed via SSE: exitCode=${exitCode}`);
            succeed(exitCode);
          }
        },
      });
      this.sseConnection = eventSource;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
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
