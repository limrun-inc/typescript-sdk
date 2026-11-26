import { randomUUID } from 'crypto';
import { WebSocket, Data } from 'ws';
import { nodeProxyTransport } from './proxy-transport';
import { isNonRetryableError } from '../tunnel';

/**
 * Connection state of an instance's signaling WebSocket.
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * Callback function for connection state changes
 */
export type ConnectionStateCallback = (state: ConnectionState) => void;

/** A message the instance sends on the signaling socket. Replies carry the request's `id`. */
export type SignalingMessage = { type: string; id: string; error?: string | null } & Record<string, any>;

export interface SignalingLogger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface SignalingTransportOptions {
  /** The instance's API URL; the socket opens at its `/signaling` path. */
  apiUrl: string;
  token: string;
  logger: SignalingLogger;
  /** Reconnect attempts after the socket drops. Defaults to 6. */
  maxReconnectAttempts?: number;
  /** First reconnect delay in milliseconds, doubled per attempt. Defaults to 1000. */
  reconnectDelay?: number;
  /** Longest reconnect delay in milliseconds. Defaults to 30000. */
  maxReconnectDelay?: number;
  /** Turns a reply into a request's result, by reply type. Unknown types resolve with the message. */
  responseHandlers?: Record<string, (message: SignalingMessage) => unknown>;
  /** Turns a reply's `error` into the error its request rejects with. Defaults to an Error with that text. */
  replyError?: (message: SignalingMessage) => Error;
  /** Consumes messages that are not replies, such as notifications and streams. True when handled. */
  handleMessage?: (message: SignalingMessage) => boolean;
  /** Called when the socket closes, with the reason pending requests failed for. */
  onConnectionLost?: (reason: string) => void;
  /** Called once the client is closed for good: on disconnect, or when reconnecting gives up. */
  onClosed?: () => void;
  /** What a request looks like in debug logs, for requests that carry secrets. */
  redactRequest?: (request: Record<string, unknown>) => Record<string, unknown>;
  /** Runs on the first open before the transport resolves; a failure rejects it. */
  onFirstOpen?: (transport: SignalingTransport) => Promise<void>;
}

/**
 * SignalingTransport is an instance's signaling WebSocket: requests matched to replies by `id`,
 * reconnects with exponential backoff, and keepAlive. The iOS and macOS clients share it.
 */
export interface SignalingTransport {
  /** The signaling WebSocket URL, token included. */
  readonly url: string;
  /**
   * Send `{type, id, ...params}` and resolve with the reply with the same `id`. A `timeoutMs` of
   * zero waits until the reply or the connection ends. Pass `id` (from {@link nextId}) to match
   * messages the instance sends before the reply, such as progress.
   */
  request<T>(
    type: string,
    params?: Record<string, unknown>,
    transform?: (message: SignalingMessage) => T,
    timeoutMs?: number,
    id?: string,
  ): Promise<T>;
  /** A new request ID. */
  nextId(): string;
  /** Send a message without waiting for a reply. False when the socket is not open. */
  send(message: Record<string, unknown>, callback?: (err?: Error) => void): boolean;
  isOpen(): boolean;
  /** Send an application-level keepAlive message. */
  keepAlive(): void;
  /** Close the socket for good and fail pending requests. */
  disconnect(): void;
  getConnectionState(): ConnectionState;
  onConnectionStateChange(callback: ConnectionStateCallback): () => void;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout | undefined;
  transform?: (message: SignalingMessage) => unknown;
};

/** The WebSocket close code for a policy violation, as the instance closes a refused session. */
const POLICY_VIOLATION = 1008;

/** signalingUrl is the signaling WebSocket URL of an instance API URL. */
export function signalingUrl(apiUrl: string, token: string): string {
  return `${apiUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/signaling?token=${token}`;
}

/**
 * Open an instance's signaling WebSocket. Resolves once it is open and `onFirstOpen` finished.
 * Only the opening handshake is retried before it resolves, once, when the failure is transient.
 */
export function openSignalingTransport(options: SignalingTransportOptions): Promise<SignalingTransport> {
  const url = signalingUrl(options.apiUrl, options.token);
  const logger = options.logger;
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 6;
  const reconnectDelay = options.reconnectDelay ?? 1000;
  const maxReconnectDelay = options.maxReconnectDelay ?? 30000;
  const responseHandlers = options.responseHandlers ?? {};

  let ws: WebSocket | undefined = undefined;
  let connectionState: ConnectionState = 'connecting';
  let reconnectAttempts = 0;
  let reconnectTimeout: NodeJS.Timeout | undefined;
  let handshakeDeadline: NodeJS.Timeout | undefined;
  let pingInterval: NodeJS.Timeout | undefined;
  let intentionalDisconnect = false;
  let lastError: string | undefined;
  // What the instance said in an error frame before closing, such as a message above the grant.
  let instanceError: string | undefined;
  const pendingRequests: Map<string, PendingRequest> = new Map();
  const stateChangeCallbacks: Set<ConnectionStateCallback> = new Set();
  const keepAliveSessionId =
    Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

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
    options.onConnectionLost?.(reason);
  };

  const cleanupConnection = (): void => {
    clearTimeout(handshakeDeadline);
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
      // A retired socket can emit an error when an unfinished handshake is cancelled.
      ws.on('error', () => {});
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      ws = undefined;
    }
  };

  const isOpen = (): boolean => !!ws && ws.readyState === WebSocket.OPEN;

  const generateId = (): string => `ts-client-${randomUUID()}`;

  const request = <T>(
    type: string,
    params: Record<string, unknown> = {},
    transform?: (message: SignalingMessage) => T,
    timeoutMs: number = 30000,
    id: string = generateId(),
  ): Promise<T> => {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not connected or connection is not open.'));
        return;
      }

      const timeout =
        timeoutMs > 0 ?
          setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Request ${type} timed out`));
          }, timeoutMs)
        : undefined;

      pendingRequests.set(
        id,
        transform ? { resolve, reject, timeout, transform } : { resolve, reject, timeout },
      );

      const message = { type, id, ...params };
      logger.debug('Sending request:', options.redactRequest ? options.redactRequest(message) : message);

      ws.send(JSON.stringify(message), (err?: Error) => {
        if (err) {
          clearTimeout(timeout);
          pendingRequests.delete(id);
          logger.error(`Failed to send ${type} request:`, err);
          reject(err);
        }
      });
    });
  };

  const send = (message: Record<string, unknown>, callback?: (err?: Error) => void): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message), callback);
    return true;
  };

  const keepAlive = (): void => {
    send({ type: 'keepAlive', sessionId: keepAliveSessionId });
  };

  const disconnect = (): void => {
    intentionalDisconnect = true;
    cleanupConnection();
    updateConnectionState('disconnected');
    failPendingRequests('Intentional disconnect');
    options.onClosed?.();
    logger.debug('Intentionally disconnected from WebSocket.');
  };

  const transport: SignalingTransport = {
    url,
    request,
    nextId: generateId,
    send,
    isOpen,
    keepAlive,
    disconnect,
    getConnectionState: () => connectionState,
    onConnectionStateChange: (callback) => {
      stateChangeCallbacks.add(callback);
      return () => {
        stateChangeCallbacks.delete(callback);
      };
    },
  };

  return new Promise<SignalingTransport>((resolveConnection, rejectConnection) => {
    let hasResolved = false;
    let retriedHandshake = false;

    // Reconnection logic with exponential backoff
    const scheduleReconnect = (): void => {
      if (intentionalDisconnect) {
        logger.debug('Skipping reconnection (intentional disconnect)');
        return;
      }

      if (isNonRetryableError(lastError ?? '')) {
        logger.error(`Skipping reconnection (non-retryable error): ${lastError}`);
        updateConnectionState('disconnected');
        options.onClosed?.();
        return;
      }

      if (reconnectAttempts >= maxReconnectAttempts) {
        logger.error(`Max reconnection attempts (${maxReconnectAttempts}) reached. Giving up.`);
        updateConnectionState('disconnected');
        options.onClosed?.();
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
      cleanupConnection();
      updateConnectionState('connecting');

      const proxyAgent = nodeProxyTransport.getWebSocketAgent(url);
      let opened = false;
      let handshakeError: Error | undefined;
      const socket = new WebSocket(url, proxyAgent ? { agent: proxyAgent } : {});
      ws = socket;
      // A socket inactivity timeout allows a slow TLS peer to keep the first command waiting.
      handshakeDeadline = setTimeout(() => {
        handshakeError = Object.assign(new Error('Opening handshake has timed out'), { code: 'ETIMEDOUT' });
        socket.terminate();
      }, 5000);

      socket.on('message', (data: Data) => {
        let message: SignalingMessage;
        try {
          message = JSON.parse(data.toString());
        } catch (e) {
          logger.error({ data, error: e }, 'Failed to parse JSON message');
          return;
        }

        if (options.handleMessage?.(message)) {
          return;
        }

        const pending = pendingRequests.get(message.id);
        if (!pending) {
          if (message.type === 'error' && message['message']) {
            // The instance explains a policy close, such as a message above the token's grant.
            instanceError = String(message['message']);
            logger.error('Instance error:', instanceError);
            return;
          }
          logger.debug(`Received response for unknown or already handled request: ${message.id}`);
          return;
        }

        clearTimeout(pending.timeout);
        pendingRequests.delete(message.id);

        if (message.error) {
          logger.debug(`Server error for ${message.type}: ${message.error}`);
          pending.reject(options.replyError ? options.replyError(message) : new Error(message.error));
          return;
        }

        // Use handler to transform response, or resolve with raw message
        const handler = pending.transform ?? responseHandlers[message.type];
        if (handler) {
          try {
            pending.resolve(handler(message));
          } catch (err) {
            pending.reject(err as Error);
          }
        } else {
          logger.warn('Received unexpected message type:', message.type);
          pending.resolve(message);
        }
      });

      socket.on('error', (err: Error) => {
        lastError = err.message;
        logger.error('WebSocket error:', err.message);
        if (!opened) handshakeError ??= err;
      });

      socket.on('close', (code: number) => {
        clearTimeout(handshakeDeadline);
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = undefined;
        }

        // A policy close, or the instance's error frame before it, refuses the token for good,
        // such as a command above its grant, so reconnecting cannot help.
        const refusal =
          instanceError ?? (code === POLICY_VIOLATION ? 'the instance closed the session' : undefined);
        instanceError = undefined;
        const shouldReconnect =
          !intentionalDisconnect &&
          !refusal &&
          !isNonRetryableError(lastError ?? '') &&
          connectionState !== 'disconnected';
        updateConnectionState('disconnected');

        logger.debug('Disconnected from server.');

        failPendingRequests(refusal ? `Connection closed: ${refusal}` : 'Connection closed');

        if (!hasResolved) {
          // Settle before onFirstOpen sees its request fail, with the instance's reason.
          const err =
            refusal ?
              new Error(refusal)
            : handshakeError ?? new Error('Connection closed before the client was ready');
          // Retry only the opening handshake. Once open, onFirstOpen owns its failure.
          const code = (err as NodeJS.ErrnoException).code;
          const transient =
            ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(
              code ?? '',
            ) ||
            /^(Opening handshake has timed out|socket hang up|Unexpected server response: 50[234])$/.test(
              err.message,
            );
          if (!refusal && !opened && !retriedHandshake && maxReconnectAttempts > 0 && transient) {
            retriedHandshake = true;
            updateConnectionState('reconnecting');
            reconnectTimeout = setTimeout(setupWebSocket, 100 + Math.floor(Math.random() * 151));
          } else {
            cleanupConnection();
            rejectConnection(err);
          }
          return;
        }
        if (shouldReconnect) {
          scheduleReconnect();
        } else if (refusal && !intentionalDisconnect) {
          logger.error(`The instance closed the session: ${refusal}`);
          cleanupConnection();
          options.onClosed?.();
        } else if (isNonRetryableError(lastError ?? '')) {
          logger.error(`Closing connection due to non-retryable error: ${lastError}`);
          cleanupConnection();
          updateConnectionState('disconnected');
          failPendingRequests('Non-retryable error');
          options.onClosed?.();
          logger.debug('Non-retryable error. Closing connection.');
        }
      });

      socket.on('open', async () => {
        clearTimeout(handshakeDeadline);
        opened = true;
        logger.debug('WebSocket connected');
        reconnectAttempts = 0;
        lastError = undefined;
        updateConnectionState('connected');

        pingInterval = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 30_000);

        if (!hasResolved) {
          try {
            await options.onFirstOpen?.(transport);
          } catch (err) {
            logger.error('Failed to prepare the client:', err);
            cleanupConnection();
            updateConnectionState('disconnected');
            rejectConnection(err as Error);
            return;
          }

          hasResolved = true;
          resolveConnection(transport);
        }
      });
    };

    setupWebSocket();
  });
}
