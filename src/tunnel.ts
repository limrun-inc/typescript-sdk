import * as net from 'net';
import { WebSocket } from 'ws';

/**
 * Controls the verbosity of logging in the tunnel
 */
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Connection state of the tunnel
 */
export type TunnelConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * Callback function for tunnel connection state changes
 */
export type TunnelConnectionStateCallback = (state: TunnelConnectionState) => void;

export interface Tunnel {
  address: {
    address: string;
    port: number;
  };
  close: () => void;
  /**
   * Get current WebSocket connection state
   */
  getConnectionState: () => TunnelConnectionState;
  /**
   * Register callback for WebSocket connection state changes
   * @returns A function to unregister the callback
   */
  onConnectionStateChange: (callback: TunnelConnectionStateCallback) => () => void;
}

export interface TcpTunnelOptions {
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
  /**
   * Controls logging verbosity
   * @default 'info'
   */
  logLevel?: LogLevel;
}

/**
 * Starts a persistent TCP → WebSocket proxy.
 *
 * The function creates a local TCP server that listens on an ephemeral port on
 * 127.0.0.1. When a TCP client connects, it forwards all traffic between that
 * client and `remoteURL` through an authenticated WebSocket. The server remains
 * active even after the client disconnects, allowing reconnection without
 * recreating the tunnel.
 *
 * @param remoteURL Remote WebSocket endpoint (e.g. wss://example.com/instance)
 * @param token     Bearer token sent as `Authorization` header
 * @param hostname  Optional IP address to listen on. Default is 127.0.0.1
 * @param port      Optional port number to listen on. Default is to ask Node.js
 *                  to find an available non-privileged port.
 * @param options   Optional reconnection configuration
 */
export async function startTcpTunnel(
  remoteURL: string,
  token: string,
  hostname: string,
  port: number,
  options?: TcpTunnelOptions,
): Promise<Tunnel> {
  const maxReconnectAttempts = options?.maxReconnectAttempts ?? 6;
  const reconnectDelay = options?.reconnectDelay ?? 1000;
  const maxReconnectDelay = options?.maxReconnectDelay ?? 30000;
  const logLevel = options?.logLevel ?? 'info';

  // Logger functions
  const logger = {
    debug: (...args: any[]) => {
      if (logLevel === 'debug') console.log('[Tunnel]', ...args);
    },
    info: (...args: any[]) => {
      if (logLevel === 'info' || logLevel === 'debug') console.log('[Tunnel]', ...args);
    },
    warn: (...args: any[]) => {
      if (logLevel === 'warn' || logLevel === 'info' || logLevel === 'debug')
        console.warn('[Tunnel]', ...args);
    },
    error: (...args: any[]) => {
      if (logLevel !== 'none') console.error('[Tunnel]', ...args);
    },
  };

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    let ws: WebSocket | undefined;
    let pingInterval: NodeJS.Timeout | undefined;
    let reconnectTimeout: NodeJS.Timeout | undefined;
    let reconnectAttempts = 0;
    let intentionalDisconnect = false;
    let tcpSocket: net.Socket | undefined;
    let connectionState: TunnelConnectionState = 'connecting';

    const stateChangeCallbacks: Set<TunnelConnectionStateCallback> = new Set();

    const updateConnectionState = (newState: TunnelConnectionState): void => {
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

    const cleanup = () => {
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
          ws.close(1000, 'close');
        }
        ws = undefined;
      }
    };

    const close = () => {
      intentionalDisconnect = true;
      cleanup();
      updateConnectionState('disconnected');
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.destroy();
      }
      if (server.listening) {
        server.close();
      }
    };

    const scheduleReconnect = (): void => {
      if (intentionalDisconnect) {
        logger.debug('Skipping reconnection (intentional disconnect)');
        return;
      }

      if (!tcpSocket || tcpSocket.destroyed) {
        logger.debug('Skipping reconnection (TCP socket closed)');
        return;
      }

      if (reconnectAttempts >= maxReconnectAttempts) {
        logger.error(`Max reconnection attempts (${maxReconnectAttempts}) reached. Closing tunnel.`);
        close();
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
      if (!tcpSocket || tcpSocket.destroyed) {
        logger.error('Cannot setup WebSocket: TCP socket is closed');
        return;
      }

      cleanup();
      updateConnectionState('connecting');

      ws = new WebSocket(remoteURL, {
        headers: { Authorization: `Bearer ${token}` },
        perMessageDeflate: false,
      });

      ws.on('error', (err: any) => {
        logger.error('WebSocket error:', err.message || err);
      });

      ws.on('close', () => {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = undefined;
        }

        const shouldReconnect = !intentionalDisconnect && connectionState !== 'disconnected';
        updateConnectionState('disconnected');

        logger.debug('WebSocket disconnected');

        // Pause TCP socket to apply backpressure - TCP will handle buffering
        if (tcpSocket && !tcpSocket.destroyed && !tcpSocket.isPaused()) {
          logger.debug('Pausing TCP socket (applying backpressure)');
          tcpSocket.pause();
        }

        if (shouldReconnect && tcpSocket && !tcpSocket.destroyed) {
          scheduleReconnect();
        }
      });

      ws.on('open', () => {
        const socket = ws as WebSocket;
        logger.debug('WebSocket connected');
        reconnectAttempts = 0;
        updateConnectionState('connected');

        pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            (socket as any).ping();
          }
        }, 30_000);

        // Resume TCP socket - queued data will flow through
        if (tcpSocket && tcpSocket.isPaused()) {
          logger.debug('Resuming TCP socket (releasing backpressure)');
          tcpSocket.resume();
        }

        // TCP → WS: Forward data directly
        const onTcpData = (chunk: Buffer) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(chunk);
          }
          // If WebSocket is not ready, data will queue in TCP buffers (backpressure)
        };

        // Remove old listener if exists and add new one
        tcpSocket!.removeListener('data', onTcpData);
        tcpSocket!.on('data', onTcpData);

        // WS → TCP
        socket.on('message', (data: any) => {
          if (tcpSocket && !tcpSocket.destroyed) {
            tcpSocket.write(data as Buffer);
          }
        });
      });
    };

    // TCP server error
    server.once('error', (err) => {
      close();
      reject(new Error(`TCP server error: ${err.message}`));
    });

    const getConnectionState = (): TunnelConnectionState => {
      return connectionState;
    };

    const onConnectionStateChange = (callback: TunnelConnectionStateCallback): (() => void) => {
      stateChangeCallbacks.add(callback);
      return () => {
        stateChangeCallbacks.delete(callback);
      };
    };

    // Listening
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        close();
        return reject(new Error('Failed to obtain listening address'));
      }
      resolve({
        address,
        close,
        getConnectionState,
        onConnectionStateChange,
      });
    });

    // Helper to clean up current connection but keep server alive
    const cleanupConnection = () => {
      cleanup();
      updateConnectionState('disconnected');
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.destroy();
        tcpSocket = undefined;
      }
      // Reset reconnection state for next connection
      reconnectAttempts = 0;
      intentionalDisconnect = false;
      logger.debug('Connection cleaned up, ready for new TCP connection');
    };

    // On TCP connection (can happen multiple times)
    server.on('connection', (socket) => {
      // If there's already an active connection, reject the new one
      if (tcpSocket && !tcpSocket.destroyed) {
        logger.debug('Rejecting new TCP connection - already have an active connection');
        socket.destroy();
        return;
      }

      logger.debug('TCP client connected');
      tcpSocket = socket;

      // TCP socket handlers
      tcpSocket.on('close', () => {
        logger.debug('TCP socket closed by client');
        cleanupConnection();
      });

      tcpSocket.on('error', (err: any) => {
        logger.error('TCP socket error:', err);
        cleanupConnection();
      });

      // Start WebSocket connection
      setupWebSocket();
    });

    // Start listening
    server.listen(port, hostname);
  });
}
