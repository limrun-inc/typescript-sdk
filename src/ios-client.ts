import { WebSocket, Data } from 'ws';
import fs from 'fs';
import { EventEmitter } from 'events';

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

/**
 * A client for interacting with a Limrun iOS instance
 */
export type InstanceClient = {
  /**
   * Take a screenshot of the current screen
   * @returns A promise that resolves to the screenshot data
   */
  screenshot: () => Promise<ScreenshotData>;

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
   * ```
   */
  simctl: (args: string[]) => SimctlExecution;

  /**
   * Copy a file to the sandbox of the simulator. Returns the path of the file that can be used in simctl commands.
   * @param name The name of the file in the sandbox of the simulator.
   * @param path The path of the file to copy to the sandbox of the simulator.
   * @returns A promise that resolves to the path of the file that can be used in simctl commands.
   */
  cp: (name: string, path: string) => Promise<string>;
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

type ScreenshotRequest = {
  type: 'screenshot';
  id: string;
};

type ScreenshotResponse = {
  type: 'screenshot';
  dataUri: string;
  id: string;
};

type ScreenshotData = {
  dataUri: string;
};

type ScreenshotErrorResponse = {
  type: 'screenshotError';
  message: string;
  id: string;
};

type SimctlRequest = {
  type: 'simctl';
  id: string;
  args: string[];
};

type SimctlStreamResponse = {
  type: 'simctlStream';
  id: string;
  stdout?: string; // base64 encoded
  stderr?: string; // base64 encoded
  exitCode?: number;
};

type SimctlErrorResponse = {
  type: 'simctlError';
  id: string;
  message: string;
};

type ServerMessage =
  | ScreenshotResponse
  | ScreenshotErrorResponse
  | SimctlStreamResponse
  | SimctlErrorResponse
  | { type: string; [key: string]: unknown };

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
  private waitPromise: Promise<{ code: number; stdout: Buffer; stderr: Buffer }> | null = null;
  private stopCallback: (() => void) | null = null;

  public get isRunning(): boolean {
    return !this.completed;
  }

  constructor(stopCallback: () => void) {
    super();
    this.stopCallback = stopCallback;
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
  wait(): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    if (this.waitPromise) {
      return this.waitPromise;
    }

    this.waitPromise = new Promise((resolve, reject) => {
      if (this.completed) {
        resolve({
          code: this.exitCodeValue!,
          stdout: Buffer.concat(this.stdoutChunks),
          stderr: Buffer.concat(this.stderrChunks),
        });
        return;
      }

      this.once('exit', (code) => {
        resolve({
          code,
          stdout: Buffer.concat(this.stdoutChunks),
          stderr: Buffer.concat(this.stderrChunks),
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
    this.stdoutLineBuffer += data.toString('utf-8');
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
    this.stderrLineBuffer += data.toString('utf-8');
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

  const screenshotRequests: Map<
    string,
    {
      resolver: (value: ScreenshotData | PromiseLike<ScreenshotData>) => void;
      rejecter: (reason?: any) => void;
    }
  > = new Map();

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
    screenshotRequests.forEach((request) => request.rejecter(new Error(reason)));
    screenshotRequests.clear();

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

    const setupWebSocket = (): void => {
      cleanup();
      updateConnectionState('connecting');

      ws = new WebSocket(endpointWebSocketUrl);

      ws.on('message', (data: Data) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(data.toString());
        } catch (e) {
          logger.error({ data, error: e }, 'Failed to parse JSON message');
          return;
        }

        switch (message.type) {
          case 'screenshot': {
            if (!('dataUri' in message) || typeof message.dataUri !== 'string' || !('id' in message)) {
              logger.warn('Received invalid screenshot message:', message);
              break;
            }

            const screenshotMessage = message as ScreenshotResponse;
            const request = screenshotRequests.get(screenshotMessage.id);

            if (!request) {
              logger.warn(
                `Received screenshot data for unknown or already handled session: ${screenshotMessage.id}`,
              );
              break;
            }

            logger.debug(`Received screenshot data URI for session ${screenshotMessage.id}.`);
            request.resolver({ dataUri: screenshotMessage.dataUri });
            screenshotRequests.delete(screenshotMessage.id);
            break;
          }
          case 'screenshotError': {
            if (!('message' in message) || !('id' in message)) {
              logger.warn('Received invalid screenshot error message:', message);
              break;
            }

            const errorMessage = message as ScreenshotErrorResponse;
            const request = screenshotRequests.get(errorMessage.id);

            if (!request) {
              logger.warn(
                `Received screenshot error for unknown or already handled session: ${errorMessage.id}`,
              );
              break;
            }

            logger.error(
              `Server reported an error capturing screenshot for session ${errorMessage.id}:`,
              errorMessage.message,
            );
            request.rejecter(new Error(errorMessage.message));
            screenshotRequests.delete(errorMessage.id);
            break;
          }
          case 'simctlStream': {
            if (!('id' in message)) {
              logger.warn('Received invalid simctl stream message:', message);
              break;
            }

            const streamMessage = message as SimctlStreamResponse;
            const execution = simctlExecutions.get(streamMessage.id);

            if (!execution) {
              logger.warn(
                `Received simctl stream for unknown or already completed execution: ${streamMessage.id}`,
              );
              break;
            }

            // Handle stdout if present
            if (streamMessage.stdout) {
              try {
                const stdoutBuffer = Buffer.from(streamMessage.stdout, 'base64');
                execution._handleStdout(stdoutBuffer);
              } catch (err) {
                logger.error('Failed to decode stdout data:', err);
              }
            }

            // Handle stderr if present
            if (streamMessage.stderr) {
              try {
                const stderrBuffer = Buffer.from(streamMessage.stderr, 'base64');
                execution._handleStderr(stderrBuffer);
              } catch (err) {
                logger.error('Failed to decode stderr data:', err);
              }
            }

            // Handle exit code if present (final message)
            if (streamMessage.exitCode !== undefined) {
              logger.debug(
                `Simctl execution ${streamMessage.id} completed with exit code ${streamMessage.exitCode}`,
              );
              execution._handleExit(streamMessage.exitCode);
              simctlExecutions.delete(streamMessage.id);
            }
            break;
          }
          case 'simctlError': {
            if (!('message' in message) || !('id' in message)) {
              logger.warn('Received invalid simctl error message:', message);
              break;
            }

            const errorMessage = message as SimctlErrorResponse;
            const execution = simctlExecutions.get(errorMessage.id);

            if (!execution) {
              logger.warn(
                `Received simctl error for unknown or already handled execution: ${errorMessage.id}`,
              );
              break;
            }

            logger.error(
              `Server reported an error for simctl execution ${errorMessage.id}:`,
              errorMessage.message,
            );
            execution._handleError(new Error(errorMessage.message));
            simctlExecutions.delete(errorMessage.id);
            break;
          }
          default:
            logger.warn('Received unexpected message type:', message);
            break;
        }
      });

      ws.on('error', (err: Error) => {
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

        const shouldReconnect = !intentionalDisconnect && connectionState !== 'disconnected';
        updateConnectionState('disconnected');

        logger.debug('Disconnected from server.');

        failPendingRequests('Connection closed');

        if (shouldReconnect) {
          scheduleReconnect();
        }
      });

      ws.on('open', () => {
        logger.debug(`Connected to ${endpointWebSocketUrl}`);
        reconnectAttempts = 0;
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
            disconnect,
            getConnectionState,
            onConnectionStateChange,
            simctl,
            cp,
          });
        }
      });
    };

    const screenshot = async (): Promise<ScreenshotData> => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('WebSocket is not connected or connection is not open.'));
      }

      const id = 'ts-client-' + Date.now();
      const screenshotRequest: ScreenshotRequest = {
        type: 'screenshot',
        id,
      };

      return new Promise<ScreenshotData>((resolve, reject) => {
        logger.debug('Sending screenshot request:', screenshotRequest);
        ws!.send(JSON.stringify(screenshotRequest), (err?: Error) => {
          if (err) {
            logger.error('Failed to send screenshot request:', err);
            reject(err);
          }
        });

        const timeout = setTimeout(() => {
          if (screenshotRequests.has(id)) {
            logger.error(`Screenshot request timed out for session ${id}`);
            screenshotRequests.get(id)?.rejecter(new Error('Screenshot request timed out'));
            screenshotRequests.delete(id);
          }
        }, 30000);
        screenshotRequests.set(id, {
          resolver: (value: ScreenshotData | PromiseLike<ScreenshotData>) => {
            clearTimeout(timeout);
            resolve(value);
            screenshotRequests.delete(id);
          },
          rejecter: (reason?: any) => {
            clearTimeout(timeout);
            reject(reason);
            screenshotRequests.delete(id);
          },
        });
      });
    };

    const simctl = (args: string[]): SimctlExecution => {
      const id = 'ts-simctl-' + Date.now() + '-' + Math.random().toString(36).substring(7);

      const cancelCallback = () => {
        // Clean up execution tracking
        simctlExecutions.delete(id);
        logger.debug(`Simctl execution ${id} cancelled`);
      };

      const execution = new SimctlExecution(cancelCallback);
      simctlExecutions.set(id, execution);

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
