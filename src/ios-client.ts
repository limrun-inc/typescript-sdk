import { WebSocket, Data } from 'ws';
import fs from 'fs';
import { EventEmitter } from 'events';
import { isNonRetryableError } from './tunnel';

/**
 * Connection state of the instance client
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * Callback function for connection state changes
 */
export type ConnectionStateCallback = (state: ConnectionState) => void;

/**
 * Events emitted by a simctl execution
 */
export interface SimctlExecutionEvents {
  stdout: (data: Buffer) => void;
  stderr: (data: Buffer) => void;
  'line-stdout': (line: string) => void;
  'line-stderr': (line: string) => void;
  exit: (code: number) => void;
  error: (error: Error) => void;
}

// ============================================================================
// Accessibility Selector - used for element-based operations
// ============================================================================

/**
 * Selector criteria for finding accessibility elements.
 * All non-undefined fields must match for an element to be selected.
 */
export type AccessibilitySelector = {
  /** Match by AXUniqueId (accessibilityIdentifier) - exact match */
  accessibilityId?: string;
  /** Match by AXLabel - exact match */
  label?: string;
  /** Match by AXLabel - contains (case-insensitive) */
  labelContains?: string;
  /** Match by element type/role (e.g., "Button", "TextField") - case-insensitive */
  elementType?: string;
  /** Match by title - exact match */
  title?: string;
  /** Match by title - contains (case-insensitive) */
  titleContains?: string;
  /** Match by AXValue - exact match */
  value?: string;
};

/**
 * A point on the screen for accessibility queries
 */
export type AccessibilityPoint = {
  x: number;
  y: number;
};

// ============================================================================
// Result Types
// ============================================================================

export type ScreenshotData = {
  /** Base64-encoded JPEG image data */
  base64: string;
  /** Width in points (for tap coordinates) */
  width: number;
  /** Height in points (for tap coordinates) */
  height: number;
};

export type TapElementResult = {
  elementLabel?: string;
  elementType?: string;
};

export type ElementResult = {
  elementLabel?: string;
};

export type InstalledApp = {
  bundleId: string;
  name: string;
  installType: string;
};

export type LsofEntry = {
  kind: 'unix';
  path: string;
};

/**
 * A client for interacting with a Limrun iOS instance
 */
export type InstanceClient = {
  /**
   * Take a screenshot of the current screen
   * @returns A promise that resolves to the screenshot data with base64 image and dimensions
   */
  screenshot: () => Promise<ScreenshotData>;

  /**
   * Get the element tree (accessibility hierarchy) of the current screen
   * @param point Optional point to get the element at that specific location
   * @returns A promise that resolves to the JSON string of the accessibility tree
   */
  elementTree: (point?: AccessibilityPoint) => Promise<string>;

  /**
   * Tap at the specified coordinates
   * @param x X coordinate in points
   * @param y Y coordinate in points
   */
  tap: (x: number, y: number) => Promise<void>;

  /**
   * Tap an accessibility element by selector
   * @param selector The selector criteria to find the element
   * @returns Information about the tapped element
   */
  tapElement: (selector: AccessibilitySelector) => Promise<TapElementResult>;

  /**
   * Increment an accessibility element (useful for sliders, steppers, etc.)
   * @param selector The selector criteria to find the element
   * @returns Information about the incremented element
   */
  incrementElement: (selector: AccessibilitySelector) => Promise<ElementResult>;

  /**
   * Decrement an accessibility element (useful for sliders, steppers, etc.)
   * @param selector The selector criteria to find the element
   * @returns Information about the decremented element
   */
  decrementElement: (selector: AccessibilitySelector) => Promise<ElementResult>;

  /**
   * Set the value of an accessibility element (useful for text fields, etc.)
   * This is much faster than typing character by character.
   * @param text The text value to set
   * @param selector The selector criteria to find the element
   * @returns Information about the modified element
   */
  setElementValue: (text: string, selector: AccessibilitySelector) => Promise<ElementResult>;

  /**
   * Type text into the currently focused input field
   * @param text The text to type
   * @param pressEnter If true, press Enter after typing
   */
  typeText: (text: string, pressEnter?: boolean) => Promise<void>;

  /**
   * Press a key on the keyboard, optionally with modifiers
   * @param key The key to press (e.g., 'a', 'enter', 'backspace', 'up', 'f1')
   * @param modifiers Optional modifier keys (e.g., ['shift'], ['command', 'shift'])
   */
  pressKey: (key: string, modifiers?: string[]) => Promise<void>;

  /**
   * Launch an installed app by bundle identifier
   * @param bundleId Bundle identifier of the app to launch
   */
  launchApp: (bundleId: string) => Promise<void>;

  /**
   * List installed apps on the simulator
   * @returns Array of installed apps with bundleId, name, and installType
   */
  listApps: () => Promise<InstalledApp[]>;

  /**
   * Open a URL in the simulator (web URLs open in Safari, deep links open corresponding apps)
   * @param url The URL to open
   */
  openUrl: (url: string) => Promise<void>;

  /**
   * Disconnect from the Limrun instance
   */
  disconnect: () => void;

  /**
   * Get current connection state
   */
  getConnectionState: () => ConnectionState;

  /**
   * Register callback for connection state changes
   * @returns A function to unregister the callback
   */
  onConnectionStateChange: (callback: ConnectionStateCallback) => () => void;

  /**
   * Run `simctl` command targeting the instance with given arguments.
   * Returns an EventEmitter that streams stdout, stderr, and exit events.
   *
   * @param args Arguments to pass to simctl
   * @param opts Options for the simctl execution
   * @param opts.disconnectOnExit If true, disconnect from the instance when the command completes
   * @returns A SimctlExecution handle for listening to command output
   *
   * @example
   * ```typescript
   * const execution = client.simctl(['boot', 'device-id']);
   *
   * // Listen to raw data
   * execution.on('stdout', (data) => {
   *   console.log('stdout:', data.toString());
   * });
   *
   * // Or listen line-by-line
   * execution.on('line-stdout', (line) => {
   *   console.log('Line:', line);
   * });
   *
   * execution.on('line-stderr', (line) => {
   *   console.error('Error:', line);
   * });
   *
   * execution.on('exit', (code) => {
   *   console.log('Process exited with code:', code);
   * });
   *
   * // Or wait for completion
   * const result = await execution.wait();
   * console.log('Exit code:', result.code);
   * console.log('Full stdout:', result.stdout.toString());
   *
   * // Disconnect from the instance when the command finishes
   * const execution2 = client.simctl(['status'], { disconnectOnExit: true });
   * ```
   */
  simctl: (args: string[], opts?: { disconnectOnExit?: boolean }) => SimctlExecution;

  /**
   * Copy a file to the sandbox of the simulator. Returns the path of the file that can be used in simctl commands.
   * @param name The name of the file in the sandbox of the simulator.
   * @param path The path of the file to copy to the sandbox of the simulator.
   * @returns A promise that resolves to the path of the file that can be used in simctl commands.
   */
  cp: (name: string, path: string) => Promise<string>;

  /**
   * List all open files on the instance. Useful to start tunnel to the
   * UNIX sockets listed here.
   * @returns A promise that resolves to a list of open files.
   */
  lsof: () => Promise<LsofEntry[]>;
};

/**
 * Controls the verbosity of logging in the client
 */
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Configuration options for creating an iOS client
 */
export type InstanceClientOptions = {
  /**
   * The API URL for the instance.
   */
  apiUrl: string;
  /**
   * The token to use for authentication.
   */
  token: string;
  /**
   * Controls logging verbosity
   * @default 'info'
   */
  logLevel?: LogLevel;
  /**
   * Maximum number of reconnection attempts
   * @default 6
   */
  maxReconnectAttempts?: number;
  /**
   * Initial reconnection delay in milliseconds
   * @default 1000
   */
  reconnectDelay?: number;
  /**
   * Maximum reconnection delay in milliseconds
   * @default 30000
   */
  maxReconnectDelay?: number;
};

// ============================================================================
// Internal Types - Message Protocol
// ============================================================================

/**
 * Generic pending request tracker
 */
type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

// Simctl uses streaming, so it's handled separately
type SimctlRequest = {
  type: 'simctl';
  id: string;
  args: string[];
};

/**
 * Generic server response with optional error
 */
type ServerResponse = {
  type: string;
  id: string;
  error?: string;
  // Response-specific fields
  base64?: string;
  width?: number;
  height?: number;
  json?: string;
  elementLabel?: string;
  elementType?: string;
  apps?: string;
  files?: LsofEntry[];
  // Simctl streaming fields
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

/**
 * Handle for a running simctl command execution.
 *
 * This class extends EventEmitter and provides streaming access to command output.
 * Methods starting with underscore (_) are internal and should not be called directly.
 *
 * @example
 * ```typescript
 * const execution = client.simctl(['boot', 'device-id']);
 *
 * // Listen to raw output
 * execution.on('stdout', (data) => console.log(data.toString()));
 *
 * // Or listen line-by-line (more convenient for most use cases)
 * execution.on('line-stdout', (line) => console.log('Output:', line));
 * execution.on('line-stderr', (line) => console.error('Error:', line));
 *
 * execution.on('exit', (code) => console.log('Exit code:', code));
 * ```
 */
export class SimctlExecution extends EventEmitter {
  private stdoutChunks: Buffer[] = [];
  private stderrChunks: Buffer[] = [];
  private stdoutLineBuffer = '';
  private stderrLineBuffer = '';
  private exitCodeValue: number | null = null;
  private completed = false;
  private waitPromise: Promise<{ code: number; stdout: string; stderr: string }> | null = null;
  private stopCallback: (() => void) | null = null;
  private encoding: BufferEncoding;

  public get isRunning(): boolean {
    return !this.completed;
  }

  constructor(stopCallback: () => void, { encoding = 'utf-8' }: { encoding?: BufferEncoding } = {}) {
    super();
    this.stopCallback = stopCallback;
    this.encoding = encoding;
  }

  /**
   * Register an event listener for stdout, stderr, line-stdout, line-stderr, exit, or error events.
   * @param event The event name
   * @param listener The callback function for this event
   */
  override on<E extends keyof SimctlExecutionEvents>(event: E, listener: SimctlExecutionEvents[E]): this {
    return super.on(event, listener as any);
  }

  /**
   * Register a one-time event listener that will be removed after firing once.
   * @param event The event name
   * @param listener The callback function for this event
   */
  override once<E extends keyof SimctlExecutionEvents>(event: E, listener: SimctlExecutionEvents[E]): this {
    return super.once(event, listener as any);
  }

  /**
   * Remove an event listener.
   * @param event The event name
   * @param listener The callback function to remove
   */
  override off<E extends keyof SimctlExecutionEvents>(event: E, listener: SimctlExecutionEvents[E]): this {
    return super.off(event, listener as any);
  }

  /**
   * Wait for the command to complete and get the full result.
   * This accumulates all stdout/stderr chunks in memory.
   * @returns Promise that resolves with exit code and complete output
   */
  wait(): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.waitPromise) {
      return this.waitPromise;
    }

    this.waitPromise = new Promise((resolve, reject) => {
      if (this.completed) {
        resolve({
          code: this.exitCodeValue!,
          stdout: Buffer.concat(this.stdoutChunks).toString(this.encoding),
          stderr: Buffer.concat(this.stderrChunks).toString(this.encoding),
        });
        return;
      }

      this.once('exit', (code) => {
        resolve({
          code,
          stdout: Buffer.concat(this.stdoutChunks).toString(this.encoding),
          stderr: Buffer.concat(this.stderrChunks).toString(this.encoding),
        });
      });

      this.once('error', (error) => {
        reject(error);
      });
    });

    return this.waitPromise;
  }

  /**
   * Stop the running simctl command (if supported by server).
   * This cleans up the execution tracking.
   */
  stop(): void {
    if (this.stopCallback) {
      this.stopCallback();
    }
  }

  /** @internal - Handle stdout data from server */
  _handleStdout(data: Buffer): void {
    this.stdoutChunks.push(data);
    this.emit('stdout', data);

    // Process line-by-line
    this.stdoutLineBuffer += data.toString(this.encoding);
    const lines = this.stdoutLineBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.stdoutLineBuffer = lines.pop() || '';

    // Emit complete lines
    for (const line of lines) {
      this.emit('line-stdout', line);
    }
  }

  /** @internal - Handle stderr data from server */
  _handleStderr(data: Buffer): void {
    this.stderrChunks.push(data);
    this.emit('stderr', data);

    // Process line-by-line
    this.stderrLineBuffer += data.toString(this.encoding);
    const lines = this.stderrLineBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.stderrLineBuffer = lines.pop() || '';

    // Emit complete lines
    for (const line of lines) {
      this.emit('line-stderr', line);
    }
  }

  /** @internal - Handle exit code from server */
  _handleExit(code: number): void {
    // Emit any remaining partial lines before exit
    if (this.stdoutLineBuffer) {
      this.emit('line-stdout', this.stdoutLineBuffer);
      this.stdoutLineBuffer = '';
    }
    if (this.stderrLineBuffer) {
      this.emit('line-stderr', this.stderrLineBuffer);
      this.stderrLineBuffer = '';
    }

    this.exitCodeValue = code;
    this.completed = true;
    this.emit('exit', code);
  }

  /** @internal - Handle errors from server or connection */
  _handleError(error: Error): void {
    this.completed = true;
    this.emit('error', error);
  }
}

/**
 * Creates a client for interacting with a Limrun iOS instance
 * @param options Configuration options including webrtcUrl, token and log level
 * @returns An InstanceClient for controlling the instance
 */
export async function createInstanceClient(options: InstanceClientOptions): Promise<InstanceClient> {
  const endpointWebSocketUrl = `${options.apiUrl
    .replace('https://', 'wss://')
    .replace('http://', 'ws://')}/signaling?token=${options.token}`;
  const logLevel = options.logLevel ?? 'info';
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 6;
  const reconnectDelay = options.reconnectDelay ?? 1000;
  const maxReconnectDelay = options.maxReconnectDelay ?? 30000;

  let ws: WebSocket | undefined = undefined;
  let connectionState: ConnectionState = 'connecting';
  let reconnectAttempts = 0;
  let reconnectTimeout: NodeJS.Timeout | undefined;
  let intentionalDisconnect = false;
  let lastError: string | undefined;

  // Centralized pending requests map - handles all request/response patterns
  const pendingRequests: Map<string, PendingRequest<any>> = new Map();

  // Simctl uses streaming, so it needs separate handling
  const simctlExecutions: Map<string, SimctlExecution> = new Map();

  const stateChangeCallbacks: Set<ConnectionStateCallback> = new Set();

  // Logger functions
  const logger = {
    debug: (...args: any[]) => {
      if (logLevel === 'debug') console.log(...args);
    },
    info: (...args: any[]) => {
      if (logLevel === 'info' || logLevel === 'debug') console.log(...args);
    },
    warn: (...args: any[]) => {
      if (logLevel === 'warn' || logLevel === 'info' || logLevel === 'debug') console.warn(...args);
    },
    error: (...args: any[]) => {
      if (logLevel !== 'none') console.error(...args);
    },
  };

  const updateConnectionState = (newState: ConnectionState): void => {
    if (connectionState !== newState) {
      connectionState = newState;
      logger.debug(`Connection state changed to: ${newState}`);
      stateChangeCallbacks.forEach((callback) => {
        try {
          callback(newState);
        } catch (err) {
          logger.error('Error in connection state callback:', err);
        }
      });
    }
  };

  const failPendingRequests = (reason: string): void => {
    pendingRequests.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(new Error(reason));
    });
    pendingRequests.clear();

    simctlExecutions.forEach((execution) => execution._handleError(new Error(reason)));
    simctlExecutions.clear();
  };

  const cleanup = (): void => {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = undefined;
    }
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = undefined;
    }
    if (ws) {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      ws = undefined;
    }
  };

  let pingInterval: NodeJS.Timeout | undefined;

  return new Promise<InstanceClient>((resolveConnection, rejectConnection) => {
    let hasResolved = false;

    // Reconnection logic with exponential backoff
    const scheduleReconnect = (): void => {
      if (intentionalDisconnect) {
        logger.debug('Skipping reconnection (intentional disconnect)');
        return;
      }

      if (isNonRetryableError(lastError ?? '')) {
        logger.error(`Skipping reconnection (non-retryable error): ${lastError}`);
        updateConnectionState('disconnected');
        return;
      }

      if (reconnectAttempts >= maxReconnectAttempts) {
        logger.error(`Max reconnection attempts (${maxReconnectAttempts}) reached. Giving up.`);
        updateConnectionState('disconnected');
        return;
      }

      const currentDelay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts), maxReconnectDelay);

      reconnectAttempts++;
      logger.debug(`Scheduling reconnection attempt ${reconnectAttempts} in ${currentDelay}ms...`);
      updateConnectionState('reconnecting');

      reconnectTimeout = setTimeout(() => {
        logger.debug(`Attempting to reconnect (attempt ${reconnectAttempts})...`);
        setupWebSocket();
      }, currentDelay);
    };

    // Generate unique request ID
    const generateId = (): string => {
      return `ts-client-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    };

    // Generic request sender with timeout and response handling
    const sendRequest = <T>(
      type: string,
      params: Record<string, unknown> = {},
      timeoutMs: number = 30000,
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket is not connected or connection is not open.'));
          return;
        }

        const id = generateId();
        const timeout = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`Request ${type} timed out`));
        }, timeoutMs);

        pendingRequests.set(id, { resolve, reject, timeout });

        const request = { type, id, ...params };
        logger.debug('Sending request:', request);

        ws.send(JSON.stringify(request), (err?: Error) => {
          if (err) {
            clearTimeout(timeout);
            pendingRequests.delete(id);
            logger.error(`Failed to send ${type} request:`, err);
            reject(err);
          }
        });
      });
    };

    // Response handlers - transform raw responses to typed results
    const responseHandlers: Record<string, (msg: ServerResponse) => unknown> = {
      screenshotResult: (msg) => ({
        base64: msg.base64!,
        width: msg.width!,
        height: msg.height!,
      }),
      elementTreeResult: (msg) => msg.json!,
      tapResult: () => undefined,
      tapElementResult: (msg) => ({
        elementLabel: msg.elementLabel,
        elementType: msg.elementType,
      }),
      incrementElementResult: (msg) => ({ elementLabel: msg.elementLabel }),
      decrementElementResult: (msg) => ({ elementLabel: msg.elementLabel }),
      setElementValueResult: (msg) => ({ elementLabel: msg.elementLabel }),
      typeTextResult: () => undefined,
      pressKeyResult: () => undefined,
      launchAppResult: () => undefined,
      listAppsResult: (msg) => JSON.parse(msg.apps || '[]') as InstalledApp[],
      listOpenFilesResult: (msg) => msg.files || [],
      openUrlResult: () => undefined,
    };

    const setupWebSocket = (): void => {
      cleanup();
      updateConnectionState('connecting');

      ws = new WebSocket(endpointWebSocketUrl);

      ws.on('message', (data: Data) => {
        let message: ServerResponse;
        try {
          message = JSON.parse(data.toString());
        } catch (e) {
          logger.error({ data, error: e }, 'Failed to parse JSON message');
          return;
        }

        // Handle simctl streaming separately (it uses multiple messages per request)
        if (message.type === 'simctlStream') {
          const execution = simctlExecutions.get(message.id);
          if (!execution) {
            logger.warn(`Received simctl stream for unknown execution: ${message.id}`);
            return;
          }

          if (message.stdout) {
            try {
              execution._handleStdout(Buffer.from(message.stdout, 'base64'));
            } catch (err) {
              logger.error('Failed to decode stdout data:', err);
            }
          }

          if (message.stderr) {
            try {
              execution._handleStderr(Buffer.from(message.stderr, 'base64'));
            } catch (err) {
              logger.error('Failed to decode stderr data:', err);
            }
          }

          if (message.exitCode !== undefined) {
            logger.debug(`Simctl execution ${message.id} completed with exit code ${message.exitCode}`);
            execution._handleExit(message.exitCode);
            simctlExecutions.delete(message.id);
          }
          return;
        }

        // Handle all other request/response patterns generically
        const request = pendingRequests.get(message.id);
        if (!request) {
          logger.debug(`Received response for unknown or already handled request: ${message.id}`);
          return;
        }

        clearTimeout(request.timeout);
        pendingRequests.delete(message.id);

        // Check for error
        if (message.error) {
          logger.error(`Server error for ${message.type}: ${message.error}`);
          request.reject(new Error(message.error));
          return;
        }

        // Use handler to transform response, or resolve with raw message
        const handler = responseHandlers[message.type];
        if (handler) {
          try {
            request.resolve(handler(message));
          } catch (err) {
            request.reject(err as Error);
          }
        } else {
          logger.warn('Received unexpected message type:', message.type);
          request.resolve(message);
        }
      });

      ws.on('error', (err: Error) => {
        lastError = err.message;
        logger.error('WebSocket error:', err.message);
        if (!hasResolved && (ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.OPEN)) {
          rejectConnection(err);
        }
      });

      ws.on('close', () => {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = undefined;
        }

        const shouldReconnect =
          !intentionalDisconnect &&
          !isNonRetryableError(lastError ?? '') &&
          connectionState !== 'disconnected';
        updateConnectionState('disconnected');

        logger.debug('Disconnected from server.');

        failPendingRequests('Connection closed');

        if (shouldReconnect) {
          scheduleReconnect();
        } else if (isNonRetryableError(lastError ?? '')) {
          logger.error(`Closing connection due to non-retryable error: ${lastError}`);
          cleanup();
          updateConnectionState('disconnected');
          failPendingRequests('Non-retryable error');
          logger.debug('Non-retryable error. Closing connection.');
        }
      });

      ws.on('open', () => {
        logger.debug(`Connected to ${endpointWebSocketUrl}`);
        reconnectAttempts = 0;
        lastError = undefined;
        updateConnectionState('connected');

        pingInterval = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            (ws as any).ping();
          }
        }, 30_000);

        if (!hasResolved) {
          hasResolved = true;
          resolveConnection({
            screenshot,
            elementTree,
            tap,
            tapElement,
            incrementElement,
            decrementElement,
            setElementValue,
            typeText,
            pressKey,
            launchApp,
            listApps,
            openUrl,
            disconnect,
            getConnectionState,
            onConnectionStateChange,
            simctl,
            cp,
            lsof,
          });
        }
      });
    };

    // ========================================================================
    // Client Methods - using centralized sendRequest
    // ========================================================================

    const screenshot = (): Promise<ScreenshotData> => {
      return sendRequest<ScreenshotData>('screenshot');
    };

    const elementTree = (point?: AccessibilityPoint): Promise<string> => {
      return sendRequest<string>('elementTree', { point });
    };

    const tap = (x: number, y: number): Promise<void> => {
      return sendRequest<void>('tap', { x, y });
    };

    const tapElement = (selector: AccessibilitySelector): Promise<TapElementResult> => {
      return sendRequest<TapElementResult>('tapElement', { selector });
    };

    const incrementElement = (selector: AccessibilitySelector): Promise<ElementResult> => {
      return sendRequest<ElementResult>('incrementElement', { selector });
    };

    const decrementElement = (selector: AccessibilitySelector): Promise<ElementResult> => {
      return sendRequest<ElementResult>('decrementElement', { selector });
    };

    const setElementValue = (text: string, selector: AccessibilitySelector): Promise<ElementResult> => {
      return sendRequest<ElementResult>('setElementValue', { text, selector });
    };

    const typeText = (text: string, pressEnter?: boolean): Promise<void> => {
      return sendRequest<void>('typeText', { text, pressEnter });
    };

    const pressKey = (key: string, modifiers?: string[]): Promise<void> => {
      return sendRequest<void>('pressKey', { key, modifiers });
    };

    const launchApp = (bundleId: string): Promise<void> => {
      return sendRequest<void>('launchApp', { bundleId });
    };

    const listApps = (): Promise<InstalledApp[]> => {
      return sendRequest<InstalledApp[]>('listApps');
    };

    const openUrl = (url: string): Promise<void> => {
      return sendRequest<void>('openUrl', { url });
    };

    const lsof = (): Promise<LsofEntry[]> => {
      return sendRequest<LsofEntry[]>('listOpenFiles', { kind: 'unix' });
    };

    const simctl = (args: string[], opts: { disconnectOnExit?: boolean } = {}): SimctlExecution => {
      const id = generateId();

      const cancelCallback = () => {
        // Clean up execution tracking
        simctlExecutions.delete(id);
        if (opts.disconnectOnExit) {
          logger.debug(`Simctl execution ${id} cancelled, disconnecting due to disconnectOnExit`);
          disconnect();
        }
        logger.debug(`Simctl execution ${id} cancelled`);
      };

      const execution = new SimctlExecution(cancelCallback);
      simctlExecutions.set(id, execution);

      // If disconnectOnExit is enabled, register listeners before any async operations
      if (opts.disconnectOnExit) {
        execution.once('exit', () => {
          logger.debug(`Simctl execution ${id} finished, disconnecting due to disconnectOnExit`);
          disconnect();
        });
        execution.once('error', () => {
          logger.debug(`Simctl execution ${id} errored, disconnecting due to disconnectOnExit`);
          disconnect();
        });
      }

      // Send request asynchronously
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Defer error to next tick to allow caller to attach listeners
        process.nextTick(() => {
          execution._handleError(new Error('WebSocket is not connected or connection is not open.'));
          simctlExecutions.delete(id);
        });
        return execution;
      }

      const simctlRequest: SimctlRequest = {
        type: 'simctl',
        id,
        args,
      };

      logger.debug('Sending simctl request:', simctlRequest);
      ws.send(JSON.stringify(simctlRequest), (err?: Error) => {
        if (err) {
          logger.error('Failed to send simctl request:', err);
          execution._handleError(err);
          simctlExecutions.delete(id);
        }
      });

      return execution;
    };

    const cp = async (name: string, filePath: string): Promise<string> => {
      const fileStream = fs.createReadStream(filePath);
      const uploadUrl = `${options.apiUrl}/files?name=${encodeURIComponent(name)}`;
      try {
        const response = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': fs.statSync(filePath).size.toString(),
            Authorization: `Bearer ${options.token}`,
          },
          body: fileStream,
          duplex: 'half',
        });
        if (!response.ok) {
          const errorBody = await response.text();
          logger.debug(`Upload failed: ${response.status} ${errorBody}`);
          throw new Error(`Upload failed: ${response.status} ${errorBody}`);
        }
        const result = (await response.json()) as { path: string };
        return result.path;
      } catch (err) {
        logger.debug(`Failed to upload file ${filePath}:`, err);
        throw err;
      }
    };

    const disconnect = (): void => {
      intentionalDisconnect = true;
      cleanup();
      updateConnectionState('disconnected');
      failPendingRequests('Intentional disconnect');
      logger.debug('Intentionally disconnected from WebSocket.');
    };

    const getConnectionState = (): ConnectionState => {
      return connectionState;
    };

    const onConnectionStateChange = (callback: ConnectionStateCallback): (() => void) => {
      stateChangeCallbacks.add(callback);
      return () => {
        stateChangeCallbacks.delete(callback);
      };
    };
    setupWebSocket();
  });
}
