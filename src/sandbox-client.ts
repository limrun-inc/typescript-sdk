import { syncApp as syncFolderImpl, type FolderSyncOptions } from './folder-sync';
import { exec, ExecChildProcess } from './exec-client';

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Build configuration for xcodebuild command.
 */
export type XcodeBuildConfig = {
  workspace?: string;
  project?: string;
  scheme?: string;
};

/**
 * Simulator connection details for configuring the sandbox.
 */
export type SimulatorConfig = {
  /** The API URL of the simulator (limulator) */
  apiUrl: string;
  /** Auth token for the simulator. If not provided, uses the sandbox token. */
  token?: string;
};

/**
 * Options for syncing source code to the sandbox.
 */
export type SyncOptions = {
  /**
   * Cache scoping key for delta basis caching. Defaults to 'xcode-sandbox'.
   * This is not sent to the server.
   */
  cacheKey?: string;
  basisCacheDir?: string;
  maxPatchBytes?: number;
  /**
   * If true, watch the folder and re-sync on any changes.
   */
  watch?: boolean;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Optional filter function to include/exclude files and directories.
   * Called with the relative path from the sync root (using forward slashes).
   * For directories, the path ends with '/'.
   * Return true to include, false to exclude.
   *
   * @example
   * // Exclude build folder
   * filter: (path) => !path.startsWith('build/')
   *
   * @example
   * // Only include source files
   * filter: (path) => path.startsWith('src/') || path.endsWith('.json')
   */
  filter?: (relativePath: string) => boolean;
};

/**
 * Result of a sync operation.
 */
export type SyncResult = {
  /** Present only when watch=true; call to stop watching */
  stopWatching?: () => void;
};

/**
 * Client for interacting with a sandboxed Xcode build service.
 */
export type XCodeSandboxClient = {
  /**
   * Sync source code to the sandbox. In watch mode, keeps syncing on changes.
   * Does NOT trigger builds - call xcodebuild() when ready.
   */
  sync: (localCodePath: string, opts?: SyncOptions) => Promise<SyncResult>;

  /**
   * Trigger xcodebuild on the synced source code.
   * Returns a ChildProcess-like object for streaming output.
   *
   * @example
   * // Stream build output
   * const build = client.xcodebuild();
   * build.stdout.on('data', (line) => console.log(line));
   * const { exitCode } = await build;
   */
  xcodebuild: (opts?: XcodeBuildConfig) => ExecChildProcess;
};

export type CreateXCodeSandboxClientOptions = {
  /** The API URL of the Xcode sandbox server */
  apiUrl: string;
  /** Auth token for the sandbox */
  token: string;
  /**
   * Simulator (limulator) connection details. Only needed if the sandbox is not
   * already configured (e.g., when created outside of an iOS instance).
   * When provided, the client will call POST /simulator to set up the connection.
   */
  simulator?: SimulatorConfig;
  /**
   * Controls logging verbosity
   * @default 'info'
   */
  logLevel?: LogLevel;
};

/**
 * Creates a client for interacting with a sandboxed Xcode build service.
 *
 * @example
 * // When using an iOS instance (simulator already configured):
 * const client = await createXCodeSandboxClient({
 *   apiUrl: instance.status.sandbox.xcode.url,
 *   token: apiKey,
 * });
 *
 * // When using a standalone sandbox (need to configure simulator):
 * const client = await createXCodeSandboxClient({
 *   apiUrl: 'https://sandbox.example.com',
 *   token: 'xxx',
 *   simulator: {
 *     apiUrl: 'https://limulator.example.com',
 *     token: 'yyy', // optional, defaults to sandbox token
 *   },
 * });
 *
 * // Sync code and build
 * await client.sync('./my-ios-app', { watch: true });
 * const build = client.xcodebuild();
 * build.stdout.on('data', (line) => console.log('[build]', line));
 * const { exitCode } = await build;
 */
export async function createXCodeSandboxClient(
  options: CreateXCodeSandboxClientOptions,
): Promise<XCodeSandboxClient> {
  const logLevel = options.logLevel ?? 'info';
  const logger = {
    debug: (...args: unknown[]) => {
      if (logLevel === 'debug') console.log('[XCodeSandbox]', ...args);
    },
    info: (...args: unknown[]) => {
      if (logLevel === 'info' || logLevel === 'debug') console.log('[XCodeSandbox]', ...args);
    },
    warn: (...args: unknown[]) => {
      if (logLevel === 'warn' || logLevel === 'info' || logLevel === 'debug')
        console.warn('[XCodeSandbox]', ...args);
    },
    error: (...args: unknown[]) => {
      if (logLevel !== 'none') console.error('[XCodeSandbox]', ...args);
    },
  };

  const logFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => {
    switch (level) {
      case 'debug':
        logger.debug(msg);
        break;
      case 'info':
        logger.info(msg);
        break;
      case 'warn':
        logger.warn(msg);
        break;
      case 'error':
        logger.error(msg);
        break;
      default:
        logger.info(msg);
        break;
    }
  };

  // Configure the simulator connection if provided
  if (options.simulator) {
    const cfg: {
      simulatorApiUrl?: string;
      simulatorToken?: string;
    } = {
      simulatorApiUrl: options.simulator.apiUrl,
      simulatorToken: options.simulator.token ?? options.token,
    };

    const res = await fetch(`${options.apiUrl}/simulator`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(cfg),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`POST /simulator failed: ${res.status} ${text}`);
    }
  }

  return {
    async sync(localCodePath: string, opts?: SyncOptions): Promise<SyncResult> {
      const codeSyncOpts: FolderSyncOptions = {
        apiUrl: options.apiUrl,
        token: options.token,
        udid: opts?.cacheKey ?? 'xcode-sandbox',
        install: false,
        filter: (relativePath: string) => {
          if (relativePath.startsWith('build/') || relativePath.startsWith('.swiftpm/')) {
            return false;
          }
          if (opts?.filter && opts.filter(relativePath)) {
            return true;
          }
          return false;
        },
        ...(opts?.basisCacheDir ? { basisCacheDir: opts.basisCacheDir } : {}),
        ...(opts?.maxPatchBytes !== undefined ? { maxPatchBytes: opts.maxPatchBytes } : {}),
        ...(opts?.watch !== undefined ? { watch: opts.watch } : {}),
        log: opts?.log ?? logFn,
      };

      const result = await syncFolderImpl(localCodePath, codeSyncOpts);
      if (result.stopWatching) {
        return { stopWatching: result.stopWatching };
      }
      return {};
    },

    xcodebuild(opts?: XcodeBuildConfig): ExecChildProcess {
      return exec(
        { command: 'xcodebuild', ...(opts && { xcodebuild: opts }) },
        {
          apiUrl: options.apiUrl,
          token: options.token,
          log: logFn,
        },
      );
    },
  };
}
