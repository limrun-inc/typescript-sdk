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
import { directInstanceHttpError } from '../internal/direct-instance-errors';
import { validateAppConfig } from '../app-config';

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
  appConfig?: Record<string, string>;
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
   * After attaching, builds will auto-install on the simulator.
   */
  attachSimulator: (
    simulator: IosInstance | { apiUrl: string; token: string },
  ) => Promise<SimulatorAttachResult>;

  /**
   * Return the currently attached simulator and latest installable build state.
   */
  getSimulator: () => Promise<SimulatorStatus>;
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
        if (options?.appConfig) {
          validateAppConfig(options.appConfig);
        }
        const request: ExecRequest = {
          command: 'xcodebuild',
          ...(settings && { xcodebuild: settings }),
          ...(options?.reactNative && { reactNative: options.reactNative }),
          ...(options?.signing && { signing: options.signing }),
          ...(options?.appConfig && { appConfig: options.appConfig }),
        };

        if (options?.upload && 'assetName' in options.upload) {
          const uploadName = options.upload.assetName;
          const requestPromise = client.assets
            .getOrCreate({ name: uploadName })
            .then((asset) => {
              request.signedUploadUrl = asset.signedUploadUrl;
              request.additionalMetadata = { signedDownloadUrl: asset.signedDownloadUrl };
              return request;
            })
            .catch((err) => {
              throw new Error(
                `Failed to create upload URL for artifact '${uploadName}': ${
                  err instanceof Error ? err.message : err
                }`,
              );
            });
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

      async attachSimulator(
        simulator: IosInstance | { apiUrl: string; token: string },
      ): Promise<SimulatorAttachResult> {
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
      },
    };
  }
}
