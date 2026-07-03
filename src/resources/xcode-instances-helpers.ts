import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { XcodeInstances as GeneratedXcodeInstances, type XcodeInstance } from './xcode-instances';
import { type IosInstance } from './ios-instances';
import { exec, type ExecChildProcess, type ExecRequest } from '../exec-client';
import {
  syncFolder as syncFolderImpl,
  type AdditionalFileSyncEntry,
  type FolderSyncOptions,
} from '../folder-sync';
import { createIgnoreFn } from '../folder-sync-ignore';
import { nodeProxyTransport } from '../internal/proxy-transport';
import { directInstanceHttpError, isDirectInstanceHttpError } from '../internal/direct-instance-errors';
import { LimrunError } from '../core/error';
import { validateBuildSettings } from '../build-settings';
import { startTcpTunnel, type Tunnel } from '../tunnel';
import { isTransientError, retryTransient } from '../rbe-session';
import { sseFetch } from '../internal/sse-fetch';
import { createEventSource } from 'eventsource-client';

export type { Tunnel } from '../tunnel';

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

export type SyncOptions = {
  /**
   * If true, watch the folder and re-sync on any changes. Defaults to true.
   */
  watch?: boolean;
  /**
   * Directory for the client-side folder-sync cache.
   * Defaults to a temporary directory under the OS temp directory.
   */
  basisCacheDir?: string;
  /** Max patch size (bytes) to send as delta before falling back to full upload. */
  maxPatchBytes?: number;
  /** If true, install the app after syncing. Defaults to true. */
  install?: boolean;
  /**
   * Optional predicate for ignoring files and directories during sync.
   * Called with the relative path from the sync root (using forward slashes).
   * For directories, the path ends with '/'.
   * Return true to ignore, false to keep.
   */
  ignore?: (relativePath: string) => boolean;
  /**
   * Extra files to sync on every sync pass.
   */
  additionalFiles?: AdditionalFileSyncEntry[];
};

export type SyncResult = {
  /** Present only when watch=true; call to stop watching */
  stopWatching?: () => void;
};

export type XcodeProjectConfig = {
  workspace?: string;
  project?: string;
  scheme?: string;
  sdk?: 'iphonesimulator' | 'iphoneos' | 'watchsimulator' | 'watchos';
  /**
   * xcodebuild configuration. Omit to use limbuild's project-type default:
   * Debug for native Xcode builds and Release for React Native / Expo builds.
   */
  configuration?: 'Debug' | 'Release';
};

export type XcodeSigningConfig = {
  certificateP12Base64?: string;
  certificatePassword?: string;
  provisioningProfileBase64?: string;
};

export type ReactNativeBuildConfig = {
  /**
   * Relative path from the synced workspace root to the Expo app directory.
   * Omit to let limbuild auto-detect the app.
   */
  expoAppDir?: string;
  /**
   * Launch URL for Debug React Native / Expo builds.
   *
   * If the build is installed on an attached iOS simulator, the app opens this
   * URL unchanged after build. Otherwise, this option has no launch effect.
   *
   * For Expo dev-client builds, pass the exact dev-client URL or development
   * server URL you want opened.
   */
  devServerURL?: string;
};

export type XcodeBuildOptions = {
  upload?: { assetName: string } | { signedUploadUrl: string };
  signing?: XcodeSigningConfig;
  reactNative?: ReactNativeBuildConfig;
  buildSettings?: Record<string, string>;
};

export type SimulatorInstallState =
  | 'notInstalled'
  | 'installedOnAttachedSimulator'
  | 'installedOnOtherSimulator';

export type SimulatorDeviceInfo = {
  arch: string;
  model: string;
  name: string;
  osVersion: string;
  platform: string;
  screenHeight: number;
  screenWidth: number;
  udid: string;
};

export type SimulatorAttachment = {
  apiUrl: string;
  iosInstanceId?: string;
  target?: SimulatorDeviceInfo;
};

export type SimulatorBuildStatus = {
  buildId: string;
  sdk: string;
  bundleId?: string;
  installState: SimulatorInstallState;
  syncDurationMs?: number;
  installDurationMs?: number;
};

export type SimulatorStatus = {
  attached: boolean;
  simulator?: SimulatorAttachment;
  latestBuild?: SimulatorBuildStatus;
};

export type SimulatorAttachResult = {
  attached: boolean;
  alreadyAttached: boolean;
  installedLastBuild: boolean;
  simulator?: SimulatorAttachment;
  latestBuild?: SimulatorBuildStatus;
  installError?: string;
};

/**
 * Status of the instance's embedded Bazel Remote Build Execution stack, as
 * reported by limbuild's /rbe endpoints.
 */
export type RbeStatus = {
  state: 'stopped' | 'starting' | 'running' | 'failed';
  /** Loopback port of the RBE gRPC frontend inside the instance, when running. */
  frontendPort?: number;
  /**
   * The Xcode version key remote actions must declare via
   * XCODE_VERSION_OVERRIDE (e.g. 26.4.0.17E192), when running. Clients
   * generate their xcode_version_config from it.
   */
  xcodeVersion?: string;
  error?: string;
};

/** Default local TCP port the RBE tunnel listens on. */
export const DEFAULT_RBE_TUNNEL_PORT = 8980;

export type RbeStartOptions = {
  /** Max size of the content-addressable store (CAS), in bytes. */
  casMaxBytes?: number;
  /** Max size of the action cache (AC), in bytes. */
  acMaxBytes?: number;
  /** Number of concurrent build actions the embedded worker runs. */
  workerConcurrency?: number;
};

export type RbeTunnelOptions = {
  /** Local port to listen on. Defaults to DEFAULT_RBE_TUNNEL_PORT (8980). */
  port?: number;
  /** Local address to listen on. Defaults to 127.0.0.1. */
  host?: string;
  logLevel?: LogLevel;
};

export type RbeInstallResult = {
  /** True when the app was synced and installed on the attached simulator. */
  installed: boolean;
  /** CFBundleIdentifier of the installed app, as reported by the simulator. */
  bundleId?: string;
  /** The .app bundle name discovered inside the .ipa (Payload/<appName>.app). */
  appName?: string;
  /** Differential-sync duration in milliseconds. */
  syncDurationMs?: number;
  /** Simulator install duration in milliseconds. */
  installDurationMs?: number;
};

export type RbeUploadOptions =
  | {
      /** Upload as a named asset: the SDK mints the presigned upload URL via assets.getOrCreate. */
      assetName: string;
      /** Optional asset TTL as a Go duration (e.g. "24h", "30m"; "1d" is invalid), forwarded to assets.getOrCreate. */
      ttl?: string;
      signedUploadUrl?: never;
    }
  | {
      /** Upload to a caller-minted presigned Limrun asset storage URL. */
      signedUploadUrl: string;
      assetName?: never;
      ttl?: never;
    };

export type RbeUploadResult = {
  /** The .app bundle name of the uploaded build; it is the root directory of the uploaded tar.gz. */
  appName: string;
  /** CFBundleIdentifier of the uploaded app, when known. */
  bundleId?: string;
  /** Presigned download URL of the asset; present when uploading by assetName. */
  signedDownloadUrl?: string;
};

/** An in-flight Bazel invocation on the instance's RBE stack. */
export type RbeActiveBuild = {
  invocationId: string;
  /** RUNNING while in flight; terminal statuses appear only on the build-end event. */
  status: 'RUNNING' | (string & {});
  /** The bazel target pattern(s) of the invocation, when known. */
  pattern?: string[];
};

/** The terminal summary of a Bazel invocation, from the build stream's end event. */
export type RbeBuildEnd = {
  invocationId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INCOMPLETE' | (string & {});
  error?: string;
};

export type XcodeClient = {
  /**
   * Sync source code to the xcode instance. In watch mode, keeps syncing on changes.
   */
  sync: (localCodePath: string, opts?: SyncOptions) => Promise<SyncResult>;

  /**
   * Trigger xcodebuild on the synced source code.
   * Returns a ChildProcess-like object for streaming output.
   *
   * @example
   * const build = xcode.xcodebuild({ scheme: 'MyApp' });
   * build.stdout.on('data', (line) => console.log(line));
   * const { exitCode } = await build;
   */
  xcodebuild: (settings?: XcodeProjectConfig, options?: XcodeBuildOptions) => ExecChildProcess;

  /**
   * Attach a simulator to this xcode instance.
   * After attaching, the latest installable build is installed on the simulator:
   * the latest xcodebuild build or the latest RBE build (whichever is newer),
   * unless that build's exact digest is already on the simulator.
   */
  attachSimulator: (
    simulator: IosInstance | { apiUrl: string; token: string },
  ) => Promise<SimulatorAttachResult>;

  /**
   * Return the currently attached simulator and latest installable build state.
   */
  getSimulator: () => Promise<SimulatorStatus>;

  /**
   * Start the instance's embedded Bazel Remote Build Execution stack.
   * Idempotent: returns the running status when already up.
   */
  startRbe: (opts?: RbeStartOptions) => Promise<RbeStatus>;

  /** Return the current RBE stack status. */
  getRbe: () => Promise<RbeStatus>;

  /** Stop the RBE stack. */
  stopRbe: () => Promise<RbeStatus>;

  /**
   * Open a local TCP listener bridged to the instance's RBE gRPC frontend
   * over a multiplexed websocket. Point bazel at it with
   * --remote_executor=grpc://127.0.0.1:<port>.
   */
  startRbeTunnel: (opts?: RbeTunnelOptions) => Promise<Tunnel>;

  /**
   * Upload the latest successful RBE build's app as an asset: the daemon
   * packages the build's .app as a tar.gz (the same artifact format
   * xcodebuild uploads produce) and pushes it to asset storage. Call after
   * `bazel build --config=limrun` succeeds. The build is recorded on the
   * instance asynchronously moments after bazel reports success, so the
   * brief no-build window right after bazel exits is retried automatically.
   */
  uploadLatestRbeBuild: (opts: RbeUploadOptions) => Promise<RbeUploadResult>;

  /**
   * List the Bazel invocations currently building on the RBE stack. Poll this
   * to discover new builds (e.g. to auto-upload on build end).
   */
  getActiveRbeBuilds: () => Promise<RbeActiveBuild[]>;

  /**
   * Wait for a Bazel invocation to finish and return its terminal summary.
   * Subscribes to the invocation's build event stream (which replays from the
   * start, so subscribing any time before the build ends is safe) and resolves
   * on the terminal event. Rejects when the stream drops or cannot be reached,
   * typically because the build already ended and its live stream was removed,
   * and on abort via the optional signal. There is no internal retry; the
   * caller owns that policy (re-subscribe while the invocation is still listed
   * active, else treat the outcome as unknown).
   */
  waitForRbeBuildEnd: (invocationId: string, opts?: { signal?: AbortSignal }) => Promise<RbeBuildEnd>;

  /**
   * Create a new iOS simulator instance and attach it to this xcode instance.
   * Deletes the simulator if attach fails so it is never leaked. Returns the new
   * simulator's instance id (record it for teardown) and the instance itself.
   */
  attachNewSimulator: () => Promise<{ iosInstanceId: string; simulator: IosInstance }>;

  /** Best-effort delete of a simulator instance. Never throws; returns success. */
  deleteSimulator: (iosInstanceId: string) => Promise<boolean>;
};

export type XcodeCreateClientParams =
  | { instance: XcodeInstance; logLevel?: LogLevel }
  | { apiUrl: string; token: string; logLevel?: LogLevel };

function createLogger(logLevel: LogLevel) {
  const shouldLog = (level: LogLevel) => {
    const levels: LogLevel[] = ['none', 'error', 'warn', 'info', 'debug'];
    return levels.indexOf(logLevel) >= levels.indexOf(level);
  };
  return (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => {
    if (!shouldLog(level)) return;
    const prefix = '[XcodeInstance]';
    if (level === 'error' || level === 'warn') {
      console[level](prefix, msg);
    } else {
      console.log(prefix, msg);
    }
  };
}

function normalizeWorkspaceRelativePath(remotePath: string): string {
  if (
    remotePath === '' ||
    remotePath.startsWith('/') ||
    remotePath.includes('\\') ||
    remotePath.includes('\0')
  ) {
    throw new Error(`invalid sandbox home path from server: ${remotePath}`);
  }
  const parts = remotePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`invalid sandbox home path from server: ${remotePath}`);
  }
  return parts.join('/');
}

async function fetchSandboxInfo(apiUrl: string, token: string): Promise<{ homeDir: string }> {
  const res = await nodeProxyTransport.fetch(`${apiUrl}/info`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const body = await readJsonResponse<{ homeDir?: string }>(res, 'GET /info');
  if (!body.homeDir) {
    throw new Error('GET /info response is missing homeDir');
  }
  return {
    homeDir: normalizeWorkspaceRelativePath(body.homeDir),
  };
}

/**
 * Derives the websocket URL of limbuild's /rbe/tunnel endpoint from the
 * instance apiUrl, mirroring deriveReverseTunnelUrl in ios-client.ts.
 */
export function deriveRbeTunnelUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else {
    throw new Error(`Unsupported apiUrl protocol for rbe tunnel: ${url.protocol}`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/rbe/tunnel`;
  url.search = '';
  url.hash = '';
  // The tunnel layer (startMultiplexedTcpTunnel) appends mode=multiplexed to
  // the URL itself, so we don't set it here.
  return url.toString();
}

/**
 * Raised when an `/rbe` request returns 404. limbuild's `/rbe` routes only
 * exist on builds with remote-execution support, so a 404 there means RBE is
 * unavailable on this instance (an older limbuild, or the wrong environment) —
 * NOT that the instance is missing. Kept distinct from NotFoundError so the CLI
 * does not mistake it for a vanished instance and spin up replacements.
 */
export class RbeUnsupportedError extends LimrunError {
  constructor(operation: string) {
    super(
      `Remote build execution is not available on this Xcode instance (${operation} returned 404). ` +
        'Its limbuild may predate RBE support, or you may be targeting the wrong environment ' +
        '(for example production instead of staging).',
    );
    this.name = 'RbeUnsupportedError';
  }
}

/**
 * Reads an `/rbe` JSON response, mapping a 404 to RbeUnsupportedError (a route
 * 404 means RBE is not supported here, never a missing instance).
 */
async function readRbeResponse<T>(res: Response, operation: string): Promise<T> {
  if (res.status === 404) {
    await res.text().catch(() => undefined);
    throw new RbeUnsupportedError(operation);
  }
  return readJsonResponse<T>(res, operation);
}

async function readJsonResponse<T>(res: Response, operation: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw directInstanceHttpError(operation, res.status, text, res.headers);
  }
  if (!text.trim()) {
    throw new Error(`${operation} returned an empty response`);
  }
  return JSON.parse(text) as T;
}

/**
 * Mints presigned upload/download URLs for a named asset via assets.getOrCreate,
 * wrapping failures with the asset name (and the original error as cause).
 * Shared by the xcodebuild `--upload` path and `uploadLatestRbeBuild`.
 */
function mintAssetUploadUrls(
  assets: { getOrCreate: (body: { name: string; ttl?: string }) => Promise<AssetUploadUrls> },
  name: string,
  ttl?: string,
): Promise<AssetUploadUrls> {
  return assets.getOrCreate({ name, ...(ttl && { ttl }) }).catch((err) => {
    const message = `Failed to create upload URL for asset '${name}': ${
      err instanceof Error ? err.message : err
    }`;
    // @ts-ignore - not all envs have native support for cause yet
    throw new Error(message, { cause: err });
  });
}

type AssetUploadUrls = { signedUploadUrl: string; signedDownloadUrl: string };

export class XcodeInstances extends GeneratedXcodeInstances {
  async createClient(params: XcodeCreateClientParams): Promise<XcodeClient> {
    let apiUrl: string;
    let token: string;
    if ('instance' in params) {
      if (!params.instance.status.apiUrl) {
        throw new Error('Instance not ready: apiUrl is not available');
      }
      apiUrl = params.instance.status.apiUrl;
      token = params.instance.status.token;
    } else {
      apiUrl = params.apiUrl;
      token = params.token;
    }

    const log = createLogger(params.logLevel ?? 'info');
    const client = this._client;
    let sandboxInfoPromise: Promise<{ homeDir: string }> | undefined;
    const getSandboxInfo = () => {
      sandboxInfoPromise ??= fetchSandboxInfo(apiUrl, token);
      return sandboxInfoPromise;
    };

    // Shared local closures. The methods below live in an object literal over
    // these closures (not `this`), so anything reused across methods is defined
    // here once and called from each method.
    const attachSimulatorImpl = async (
      simulator: IosInstance | { apiUrl: string; token: string },
    ): Promise<SimulatorAttachResult> => {
      let simApiUrl: string;
      let simToken: string;
      if ('status' in simulator) {
        if (!simulator.status.apiUrl) {
          throw new Error('Simulator instance not ready: apiUrl is not available');
        }
        simApiUrl = simulator.status.apiUrl;
        simToken = simulator.status.token;
      } else {
        simApiUrl = simulator.apiUrl;
        simToken = simulator.token;
      }
      const res = await nodeProxyTransport.fetch(`${apiUrl}/simulator`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ apiUrl: simApiUrl, token: simToken }),
      });
      return readJsonResponse<SimulatorAttachResult>(res, 'POST /simulator');
    };

    const deleteSimulatorImpl = async (iosInstanceId: string): Promise<boolean> => {
      try {
        await client.iosInstances.delete(iosInstanceId);
        return true;
      } catch {
        return false;
      }
    };

    const attachNewSimulatorImpl = async (): Promise<{
      iosInstanceId: string;
      simulator: IosInstance;
    }> => {
      const simulator = await client.iosInstances.create({ wait: true });
      // The sim exists from here; if attach fails, delete it so we never leak an
      // orphan the caller can't reap.
      try {
        await attachSimulatorImpl(simulator);
      } catch (err) {
        await deleteSimulatorImpl(simulator.metadata.id);
        throw err;
      }
      return { iosInstanceId: simulator.metadata.id, simulator };
    };

    return {
      async sync(localCodePath: string, opts?: SyncOptions): Promise<SyncResult> {
        const resolvedPath = path.resolve(localCodePath);
        const folderName = path.basename(resolvedPath);
        const hash = crypto.createHash('sha1').update(resolvedPath).digest('hex').slice(0, 8);
        const cacheKey = `limsync-cache-${folderName}-${hash}`;
        const basisCacheDir = opts?.basisCacheDir ?? path.join(os.tmpdir(), cacheKey);
        const sandboxInfo =
          opts?.additionalFiles && opts.additionalFiles.length > 0 ? await getSandboxInfo() : undefined;
        const additionalFiles = opts?.additionalFiles?.map((file) => ({
          localPath: file.localPath,
          remotePath:
            sandboxInfo && file.remotePath.startsWith('~/') ?
              `${sandboxInfo.homeDir}/${file.remotePath.slice(2)}`
            : file.remotePath,
        }));
        const codeSyncOpts: FolderSyncOptions = {
          apiUrl,
          token,
          udid: cacheKey,
          install: opts?.install ?? true,
          ignoreFn: await createIgnoreFn(localCodePath, {
            basisCacheDir,
            log,
            additional: (relativePath: string) => {
              if (
                relativePath.startsWith('build/') ||
                relativePath.startsWith('.build/') ||
                relativePath.startsWith('DerivedData/') ||
                relativePath.startsWith('Index.noindex/') ||
                relativePath.startsWith('ModuleCache.noindex/') ||
                relativePath.startsWith('.index-build/')
              ) {
                return true;
              }
              if (
                relativePath.startsWith('.swiftpm/') ||
                relativePath.startsWith('Pods/') ||
                relativePath.startsWith('Carthage/Build/')
              ) {
                return true;
              }
              if (relativePath.includes('/xcuserdata/')) {
                return true;
              }
              if (relativePath.includes('.dSYM/')) {
                return true;
              }
              if (opts?.ignore?.(relativePath)) {
                return true;
              }
              return false;
            },
          }),
          basisCacheDir,
          watch: opts?.watch ?? true,
          maxPatchBytes: opts?.maxPatchBytes ?? 4 * 1024 * 1024,
          launchMode: 'ForegroundIfRunning',
          log,
          ...(additionalFiles ? { additionalFiles } : {}),
        };

        const result = await syncFolderImpl(localCodePath, codeSyncOpts);
        if (result.stopWatching) {
          return { stopWatching: result.stopWatching };
        }
        return {};
      },

      xcodebuild(settings?: XcodeProjectConfig, options?: XcodeBuildOptions): ExecChildProcess {
        if (options?.reactNative?.devServerURL && settings?.configuration === 'Release') {
          throw new Error('reactNative.devServerURL is only supported for Debug builds');
        }
        if (options?.buildSettings) {
          validateBuildSettings(options.buildSettings);
        }
        const request: ExecRequest = {
          command: 'xcodebuild',
          ...(settings && { xcodebuild: settings }),
          ...(options?.reactNative && { reactNative: options.reactNative }),
          ...(options?.signing && { signing: options.signing }),
          ...(options?.buildSettings && { buildSettings: options.buildSettings }),
        };

        if (options?.upload && 'assetName' in options.upload) {
          const requestPromise = mintAssetUploadUrls(client.assets, options.upload.assetName).then(
            (asset) => {
              request.signedUploadUrl = asset.signedUploadUrl;
              request.additionalMetadata = { signedDownloadUrl: asset.signedDownloadUrl };
              return request;
            },
          );
          return exec(requestPromise, { apiUrl, token, log });
        }

        if (options?.upload && 'signedUploadUrl' in options.upload) {
          request.signedUploadUrl = options.upload.signedUploadUrl;
        }

        return exec(request, { apiUrl, token, log });
      },

      async getSimulator(): Promise<SimulatorStatus> {
        const res = await nodeProxyTransport.fetch(`${apiUrl}/simulator`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        return readJsonResponse<SimulatorStatus>(res, 'GET /simulator');
      },

      attachSimulator: attachSimulatorImpl,
      attachNewSimulator: attachNewSimulatorImpl,
      deleteSimulator: deleteSimulatorImpl,

      async startRbe(opts?: RbeStartOptions): Promise<RbeStatus> {
        const res = await nodeProxyTransport.fetch(`${apiUrl}/rbe`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(opts ?? {}),
        });
        return readRbeResponse<RbeStatus>(res, 'POST /rbe');
      },

      async getRbe(): Promise<RbeStatus> {
        const res = await nodeProxyTransport.fetch(`${apiUrl}/rbe`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        return readRbeResponse<RbeStatus>(res, 'GET /rbe');
      },

      async stopRbe(): Promise<RbeStatus> {
        const res = await nodeProxyTransport.fetch(`${apiUrl}/rbe`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        return readRbeResponse<RbeStatus>(res, 'DELETE /rbe');
      },

      async startRbeTunnel(opts?: RbeTunnelOptions): Promise<Tunnel> {
        return startTcpTunnel(
          deriveRbeTunnelUrl(apiUrl),
          token,
          opts?.host ?? '127.0.0.1',
          opts?.port ?? DEFAULT_RBE_TUNNEL_PORT,
          {
            mode: 'multiplexed',
            logLevel: opts?.logLevel ?? params.logLevel ?? 'info',
          },
        );
      },

      async uploadLatestRbeBuild(opts: RbeUploadOptions): Promise<RbeUploadResult> {
        let signedUploadUrl: string;
        let signedDownloadUrl: string | undefined;
        if (opts.assetName !== undefined) {
          if (!opts.assetName) {
            throw new Error('assetName must not be empty');
          }
          const asset = await mintAssetUploadUrls(client.assets, opts.assetName, opts.ttl);
          signedUploadUrl = asset.signedUploadUrl;
          signedDownloadUrl = asset.signedDownloadUrl;
        } else {
          signedUploadUrl = opts.signedUploadUrl;
        }

        const post = async (): Promise<{ appName: string; bundleId?: string }> => {
          // The daemon uploads to asset storage before responding, so this
          // request can go minutes without response bytes.
          const res = await nodeProxyTransport.fetchLongRequest(`${apiUrl}/rbe/upload`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ signedUploadUrl }),
          });
          if (res.status === 404) {
            // A vanished instance and a limbuild that predates the endpoint
            // 404 indistinguishably (identical bodies), and neither is the
            // RbeUnsupportedError case (the daemon may well support /rbe),
            // hence a plain two-cause error.
            await res.text().catch(() => undefined);
            throw new Error(
              'POST /rbe/upload returned 404: the instance may no longer exist, or its limbuild ' +
                'predates RBE upload support. Recreate the instance and retry.',
            );
          }
          return readJsonResponse<{ appName: string; bundleId?: string }>(res, 'POST /rbe/upload');
        };

        // Build recording is asynchronous on the daemon (it lands moments
        // after bazel reports success), so the no-build 400 fired right at
        // build end is as transient as a gateway blip; retry both classes.
        const retryOn = (err: unknown) =>
          isTransientError(err) ||
          (isDirectInstanceHttpError(err, 400) && /no successful RBE app build/i.test(err.body));
        const result = await retryTransient(post, { retryOn });
        return { ...result, ...(signedDownloadUrl && { signedDownloadUrl }) };
      },

      async getActiveRbeBuilds(): Promise<RbeActiveBuild[]> {
        const res = await nodeProxyTransport.fetch(`${apiUrl}/rbe/builds/active`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        // readRbeResponse: a 404 here means a limbuild that predates this
        // route, not a vanished instance (same trap as the other /rbe routes).
        return readRbeResponse<RbeActiveBuild[]>(res, 'GET /rbe/builds/active');
      },

      waitForRbeBuildEnd(invocationId: string, opts?: { signal?: AbortSignal }): Promise<RbeBuildEnd> {
        return new Promise<RbeBuildEnd>((resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(new Error(`waiting for build ${invocationId} was aborted`));
            return;
          }
          // Both settle paths close the source: eventsource-client
          // auto-reconnects otherwise, which would retry-loop against the
          // stream once the daemon removes it.
          let settled = false;
          const cleanup = () => {
            eventSource.close();
            opts?.signal?.removeEventListener('abort', onAbort);
          };
          const settleResolve = (end: RbeBuildEnd) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(end);
          };
          const settleReject = (err: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
          };
          const onAbort = () => settleReject(new Error(`waiting for build ${invocationId} was aborted`));
          const eventSource = createEventSource({
            url: `${apiUrl}/exec/${invocationId}/events`,
            fetch: sseFetch(nodeProxyTransport.fetch, (err) =>
              settleReject(
                new Error(
                  `build event stream for ${invocationId} is unreachable: ${
                    err instanceof Error ? err.message : err
                  }`,
                ),
              ),
            ),
            headers: { Authorization: `Bearer ${token}` },
            onMessage: (message) => {
              if (message.event !== 'end') {
                return; // meta and log frames
              }
              let end: RbeBuildEnd;
              try {
                end = JSON.parse(message.data) as RbeBuildEnd;
              } catch (err) {
                settleReject(new Error(`invalid build end event for ${invocationId}: ${err}`));
                return;
              }
              settleResolve(end);
            },
            onDisconnect: () => {
              settleReject(
                new Error(
                  `build event stream for ${invocationId} ended without a terminal event ` +
                    '(the build may have finished and its live stream been removed)',
                ),
              );
            },
          });
          opts?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    };
  }
}
