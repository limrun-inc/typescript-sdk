import { syncFolder as syncFolderImpl, type FolderSyncOptions } from './folder-sync';
import { exec, type ExecChildProcess } from './exec-client';

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

export type XcodeBuildConfig = {
  workspace?: string;
  project?: string;
  scheme?: string;
  configuration?: string;
  sdk?: string;
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
};

/**
 * Result of a sync operation.
 */
export type SyncResult = {
  /** Present only when watch=true; call to stop watching */
  stopWatching?: () => void;
};

/**
 * Options for xcodebuild command.
 */
export type XcodeBuildOptions = {
  // Future: build config overrides
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
  xcodebuild: (opts?: XcodeBuildOptions) => ExecChildProcess;
};

export type CreateXCodeSandboxClientOptions = {
  /** The API URL of the Xcode sandbox server */
  apiUrl: string;
  /** Auth token for the sandbox */
  token: string;
  /**
   * Simulator (limulator) connection details. Only needed if the sandbox is not
   * already configured (e.g., when created outside of an iOS instance).
   * When provided, the client will call POST /config to set up the connection.
   */
  simulator?: SimulatorConfig;
  /**
   * Build configuration overrides (workspace, scheme, etc.)
   */
  buildConfig?: XcodeBuildConfig;
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

  // Configure the server if needed (partial updates supported)
  if (options.simulator || options.buildConfig) {
    const cfg: {
      limulatorBaseUrl?: string;
      limulatorAuthHeader?: string;
      buildConfig?: XcodeBuildConfig;
    } = {};

    if (options.simulator) {
      cfg.limulatorBaseUrl = options.simulator.apiUrl;
      cfg.limulatorAuthHeader = `Bearer ${options.simulator.token ?? options.token}`;
    }
    if (options.buildConfig) {
      cfg.buildConfig = options.buildConfig;
    }

    const res = await fetch(`${options.apiUrl}/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(cfg),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`xcode /config failed: ${res.status} ${text}`);
    }
  }

  // Track in-flight sync operations so xcodebuild can wait for them
  let currentSyncPromise: Promise<void> | null = null;
  let syncResolve: (() => void) | null = null;

  // Called when a sync operation starts (internal, not exposed to users)
  const onSyncStart = () => {
    if (!currentSyncPromise) {
      currentSyncPromise = new Promise<void>((resolve) => {
        syncResolve = resolve;
      });
    }
  };

  // Called when a sync operation completes
  const onSyncEnd = () => {
    if (syncResolve) {
      syncResolve();
      syncResolve = null;
      currentSyncPromise = null;
    }
  };

  // Wait for any in-flight sync to complete
  const waitForSync = async () => {
    if (currentSyncPromise) {
      logger.debug('Waiting for in-flight sync to complete before building...');
      await currentSyncPromise;
    }
  };

  return {
    async sync(localCodePath: string, opts?: SyncOptions): Promise<SyncResult> {
      const codeSyncOpts: FolderSyncOptions = {
        apiUrl: options.apiUrl,
        token: options.token,
        udid: opts?.cacheKey ?? 'xcode-sandbox',
        install: false,
        ...(opts?.basisCacheDir ? { basisCacheDir: opts.basisCacheDir } : {}),
        ...(opts?.maxPatchBytes !== undefined ? { maxPatchBytes: opts.maxPatchBytes } : {}),
        ...(opts?.watch !== undefined ? { watch: opts.watch } : {}),
        onSyncStart, // Internal: track when syncs start
        onSync: onSyncEnd, // Internal: track when syncs complete
        log: opts?.log ?? logFn,
      };

      const result = await syncFolderImpl(localCodePath, codeSyncOpts);
      if (result.stopWatching) {
        return { stopWatching: result.stopWatching };
      }
      return {};
    },

    xcodebuild(_opts?: XcodeBuildOptions): ExecChildProcess {
      // Wait for any in-flight sync before starting the build
      // We wrap the exec call to handle the async wait
      return execWithSyncWait(
        { command: 'xcodebuild' },
        {
          apiUrl: options.apiUrl,
          token: options.token,
          log: logFn,
        },
        waitForSync,
      );
    },
  };
}

/**
 * Wraps exec() to wait for sync before starting.
 * Returns an ExecChildProcess that delays the actual exec until sync completes.
 */
function execWithSyncWait(
  request: { command: 'xcodebuild' },
  execOptions: {
    apiUrl: string;
    token: string;
    log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  },
  waitForSync: () => Promise<void>,
): ExecChildProcess {
  type DataListener = (line: string) => void;
  type ErrorListener = (err: Error) => void;
  type EndListener = () => void;

  const dataListeners: DataListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const endListeners: EndListener[] = [];

  let realProcess: ExecChildProcess | null = null;
  let execIdValue: string | undefined = undefined;

  // Start the real exec after waiting for sync
  const startPromise = (async () => {
    await waitForSync();
    realProcess = exec(request, execOptions);
    execIdValue = realProcess.execId;

    // Forward events from real process to our listeners
    dataListeners.forEach((listener) => realProcess!.stdout.on('data', listener));
    errorListeners.forEach((listener) => realProcess!.stdout.on('error', listener));
    endListeners.forEach((listener) => realProcess!.stdout.on('end', listener));

    return realProcess;
  })();

  // Create a promise that resolves with the exec result
  const resultPromise = startPromise.then((proc) => proc) as ExecChildProcess;

  // Add stdout event emitter that queues listeners until real process starts
  const stdoutEmitter = {
    on(event: string, listener: DataListener | ErrorListener | EndListener): void {
      if (event === 'data') {
        dataListeners.push(listener as DataListener);
        if (realProcess) realProcess.stdout.on('data', listener as DataListener);
      } else if (event === 'error') {
        errorListeners.push(listener as ErrorListener);
        if (realProcess) realProcess.stdout.on('error', listener as ErrorListener);
      } else if (event === 'end') {
        endListeners.push(listener as EndListener);
        if (realProcess) realProcess.stdout.on('end', listener as EndListener);
      }
    },
  };
  resultPromise.stdout = stdoutEmitter as ExecChildProcess['stdout'];

  resultPromise.kill = async () => {
    if (realProcess) {
      await realProcess.kill();
    }
  };

  Object.defineProperty(resultPromise, 'execId', {
    get: () => execIdValue ?? realProcess?.execId,
  });

  return resultPromise;
}

// Re-export for backward compatibility
export { type ExecChildProcess } from './exec-client';

// Legacy type aliases for backward compatibility
/** @deprecated Use XCodeSandboxClient instead */
export type XcodeClient = XCodeSandboxClient;
/** @deprecated Use CreateXCodeSandboxClientOptions instead */
export type CreateXcodeClientOptions = CreateXCodeSandboxClientOptions;
/** @deprecated Use SyncOptions instead */
export type XcodeSyncCodeOptions = SyncOptions;
/** @deprecated Use createXCodeSandboxClient instead */
export const createXcodeClient = createXCodeSandboxClient;
