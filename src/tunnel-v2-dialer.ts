import net from 'net';
import { WebSocket, type RawData } from 'ws';
import { nodeProxyTransport } from './internal/proxy-transport';
import {
  TUNNEL_V2_CONN_ID_HEADER_BYTES,
  TUNNEL_V2_VERSION,
  TunnelV2ProtocolError,
  assertTunnelV2OpenAllowed,
  assertTunnelV2Ready,
  decodeTunnelV2ServerMessage,
  encodeTunnelV2ClientMessage,
  validateTunnelV2Routes,
  type TunnelV2Binding,
  type TunnelV2ClientMessage,
  type TunnelV2OpenFailureReason,
  type TunnelV2Route,
  type TunnelV2ResetReason,
  type TunnelV2ServerMessage,
} from './tunnel-v2';
import type { LogLevel, TunnelConnectionState, TunnelConnectionStateCallback } from './tunnel';

export interface DestinationTcpTunnel {
  tunnelId: string;
  bindings: TunnelV2Binding[];
  close: () => void;
  getConnectionState: () => TunnelConnectionState;
  onConnectionStateChange: (callback: TunnelConnectionStateCallback) => () => void;
}

export interface DestinationTcpTunnelOptions {
  routes: TunnelV2Route[];
  logLevel?: LogLevel;
  maxConnections?: number;
  maxPendingBytesPerConnection?: number;
  maxTotalPendingBytes?: number;
  maxBufferedBytes?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  livenessTimeoutMs?: number;
}

interface DialConnection {
  socket: net.Socket;
  phase: 'connecting' | 'open';
  connectTimer: NodeJS.Timeout;
  localInputEnded: boolean;
  remoteInputEnded: boolean;
  pendingWriteBytes: number;
}

export async function startDestinationTcpTunnel(
  remoteURL: string,
  token: string,
  options: DestinationTcpTunnelOptions,
): Promise<DestinationTcpTunnel> {
  const routes = validateTunnelV2Routes(options.routes);
  const logLevel = options.logLevel ?? 'info';
  const maxConnections = positiveInteger(options.maxConnections ?? 64, 'maxConnections');
  const maxPendingBytesPerConnection = positiveInteger(
    options.maxPendingBytesPerConnection ?? 16 * 1024 * 1024,
    'maxPendingBytesPerConnection',
  );
  const maxTotalPendingBytes = positiveInteger(
    options.maxTotalPendingBytes ?? 16 * 1024 * 1024,
    'maxTotalPendingBytes',
  );
  const maxBufferedBytes = positiveInteger(options.maxBufferedBytes ?? 4 * 1024 * 1024, 'maxBufferedBytes');
  const connectTimeoutMs = positiveInteger(options.connectTimeoutMs ?? 10_000, 'connectTimeoutMs');
  const handshakeTimeoutMs = positiveInteger(options.handshakeTimeoutMs ?? 15_000, 'handshakeTimeoutMs');
  const livenessTimeoutMs = positiveInteger(options.livenessTimeoutMs ?? 90_000, 'livenessTimeoutMs');
  const pingIntervalMs = Math.min(30_000, Math.max(1, Math.floor(livenessTimeoutMs / 3)));
  const resumeBelowBufferedBytes = maxBufferedBytes / 4;
  const hardMaxBufferedBytes = maxBufferedBytes + Math.max(64 * 1024, Math.floor(maxBufferedBytes / 4));

  const logger = {
    debug: (...args: unknown[]) => {
      if (logLevel === 'debug') console.log('[DestinationTunnel]', ...args);
    },
    info: (...args: unknown[]) => {
      if (logLevel === 'info' || logLevel === 'debug') console.log('[DestinationTunnel]', ...args);
    },
    warn: (...args: unknown[]) => {
      if (logLevel === 'warn' || logLevel === 'info' || logLevel === 'debug') {
        console.warn('[DestinationTunnel]', ...args);
      }
    },
    error: (...args: unknown[]) => {
      if (logLevel !== 'none') console.error('[DestinationTunnel]', ...args);
    },
  };

  return new Promise((resolve, reject) => {
    const connections = new Map<number, DialConnection>();
    const recentlyClosed = new Map<number, NodeJS.Timeout>();
    const stateChangeCallbacks = new Set<TunnelConnectionStateCallback>();
    const url = new URL(remoteURL);
    const proxyAgent = nodeProxyTransport.getWebSocketAgent(url.toString());
    const ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      ...(proxyAgent ? { agent: proxyAgent } : {}),
      perMessageDeflate: false,
    });

    let connectionState: TunnelConnectionState = 'connecting';
    let pingInterval: NodeJS.Timeout | undefined;
    let handshakeTimer: NodeJS.Timeout | undefined;
    let livenessTimer: NodeJS.Timeout | undefined;
    let tunnelReady = false;
    let closed = false;
    let pausedForBackpressure = false;
    let totalPendingWriteBytes = 0;

    const updateConnectionState = (state: TunnelConnectionState): void => {
      if (connectionState === state) return;
      connectionState = state;
      for (const callback of stateChangeCallbacks) {
        try {
          callback(state);
        } catch (error) {
          logger.error('Connection state callback failed:', error);
        }
      }
    };

    const getConnectionState = (): TunnelConnectionState => connectionState;

    const onConnectionStateChange = (callback: TunnelConnectionStateCallback): (() => void) => {
      stateChangeCallbacks.add(callback);
      return () => stateChangeCallbacks.delete(callback);
    };

    const markRecentlyClosed = (connId: number): void => {
      const existingTimer = recentlyClosed.get(connId);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => recentlyClosed.delete(connId), 30_000);
      timer.unref();
      recentlyClosed.set(connId, timer);
    };

    const removeConnection = (connId: number, destroySocket: boolean): void => {
      const connection = connections.get(connId);
      if (!connection) return;
      connections.delete(connId);
      clearTimeout(connection.connectTimer);
      markRecentlyClosed(connId);
      if (destroySocket && !connection.socket.destroyed) {
        connection.socket.destroy();
      }
    };

    const closeAllConnections = (): void => {
      for (const connId of Array.from(connections.keys())) {
        removeConnection(connId, true);
      }
      for (const timer of recentlyClosed.values()) {
        clearTimeout(timer);
      }
      recentlyClosed.clear();
      pausedForBackpressure = false;
    };

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = undefined;
      }
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      }
      if (livenessTimer) {
        clearTimeout(livenessTimer);
        livenessTimer = undefined;
      }
      closeAllConnections();
      ws.removeAllListeners('open');
      ws.removeAllListeners('message');
      ws.removeAllListeners('ping');
      ws.removeAllListeners('pong');
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'close');
      }
      updateConnectionState('disconnected');
    };

    const failTransport = (error: Error): void => {
      if (closed) return;
      logger.error(error.message);
      close();
      if (!tunnelReady) {
        reject(error);
      }
    };

    const pauseForBackpressure = (): void => {
      if (pausedForBackpressure) return;
      pausedForBackpressure = true;
      for (const connection of connections.values()) {
        if (!connection.socket.destroyed) connection.socket.pause();
      }
    };

    const resumeIfDrained = (): void => {
      if (!pausedForBackpressure || ws.bufferedAmount >= resumeBelowBufferedBytes) return;
      pausedForBackpressure = false;
      for (const connection of connections.values()) {
        if (!connection.socket.destroyed) connection.socket.resume();
      }
    };

    const frameQueued = (): void => {
      if (ws.bufferedAmount > hardMaxBufferedBytes) {
        failTransport(new Error('destination tunnel WebSocket send buffer exceeded its hard limit'));
      } else if (!pausedForBackpressure && ws.bufferedAmount > maxBufferedBytes) {
        pauseForBackpressure();
      }
    };

    const frameSent = (error?: Error): void => {
      if (error) {
        failTransport(error);
      } else {
        resumeIfDrained();
      }
    };

    const sendControl = (message: TunnelV2ClientMessage): void => {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        failTransport(new Error('destination tunnel WebSocket is not open'));
        return;
      }
      ws.send(encodeTunnelV2ClientMessage(message), frameSent);
      frameQueued();
    };

    const sendData = (connId: number, payload: Buffer): void => {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        failTransport(new Error('destination tunnel WebSocket closed while sending data'));
        return;
      }
      const frame = Buffer.allocUnsafe(TUNNEL_V2_CONN_ID_HEADER_BYTES + payload.length);
      frame.writeUInt32BE(connId, 0);
      payload.copy(frame, TUNNEL_V2_CONN_ID_HEADER_BYTES);
      ws.send(frame, { binary: true }, frameSent);
      frameQueued();
    };

    const sendOpenFailure = (connId: number, reason: TunnelV2OpenFailureReason, osCode?: string): void => {
      sendControl({
        type: 'openFail',
        connId,
        reason,
        ...(osCode ? { osCode } : {}),
      });
      markRecentlyClosed(connId);
    };

    const sendReset = (connId: number, reason: TunnelV2ResetReason, osCode?: string): void => {
      sendControl({
        type: 'reset',
        connId,
        reason,
        ...(osCode ? { osCode } : {}),
      });
    };

    const handleOpen = (message: Extract<TunnelV2ServerMessage, { type: 'open' }>): void => {
      try {
        assertTunnelV2OpenAllowed(message, routes);
      } catch {
        sendOpenFailure(message.connId, 'route_not_allowed');
        return;
      }
      if (connections.has(message.connId) || recentlyClosed.has(message.connId)) {
        throw new TunnelV2ProtocolError(`server reused connection ID ${message.connId}`);
      }
      if (connections.size >= maxConnections) {
        sendOpenFailure(message.connId, 'resource_exhausted');
        return;
      }

      const socket = net.createConnection({
        host: message.host,
        port: message.port,
        allowHalfOpen: true,
      });
      const connectTimer = setTimeout(() => {
        if (connections.get(message.connId)?.phase !== 'connecting') return;
        sendOpenFailure(message.connId, 'connection_timed_out', 'ETIMEDOUT');
        removeConnection(message.connId, true);
      }, connectTimeoutMs);
      connectTimer.unref();
      const connection: DialConnection = {
        socket,
        phase: 'connecting',
        connectTimer,
        localInputEnded: false,
        remoteInputEnded: false,
        pendingWriteBytes: 0,
      };
      connections.set(message.connId, connection);
      if (pausedForBackpressure) {
        socket.pause();
      }

      socket.once('connect', () => {
        if (connections.get(message.connId) !== connection) return;
        clearTimeout(connectTimer);
        connection.phase = 'open';
        sendControl({ type: 'openOk', connId: message.connId });
        logger.debug(`Connected ${message.connId} to ${message.host}:${message.port}`);
      });

      socket.on('data', (payload: Buffer) => {
        if (connections.get(message.connId) !== connection || connection.phase !== 'open') return;
        sendData(message.connId, payload);
      });

      socket.once('end', () => {
        if (connections.get(message.connId) !== connection || connection.phase !== 'open') return;
        connection.localInputEnded = true;
        sendControl({ type: 'fin', connId: message.connId });
      });

      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (connections.get(message.connId) !== connection) return;
        if (connection.phase === 'connecting') {
          sendOpenFailure(message.connId, classifyOpenFailure(error), error.code);
        } else {
          sendReset(message.connId, 'connection_error', error.code);
        }
        removeConnection(message.connId, true);
      });

      socket.once('close', () => {
        if (connections.get(message.connId) !== connection) return;
        if (connection.phase === 'connecting') {
          sendOpenFailure(message.connId, 'internal');
        } else if (!connection.localInputEnded || !connection.remoteInputEnded) {
          sendReset(message.connId, 'connection_error');
        }
        removeConnection(message.connId, false);
      });
    };

    const findOpenConnection = (connId: number): DialConnection | undefined => {
      const connection = connections.get(connId);
      if (connection?.phase === 'open') return connection;
      if (connection) {
        sendReset(connId, 'protocol_error');
        removeConnection(connId, true);
      } else if (!recentlyClosed.has(connId)) {
        sendReset(connId, 'protocol_error');
        markRecentlyClosed(connId);
      }
      return undefined;
    };

    const handleRemoteFIN = (connId: number): void => {
      const connection = findOpenConnection(connId);
      if (!connection) return;
      if (connection.remoteInputEnded) {
        sendReset(connId, 'protocol_error');
        removeConnection(connId, true);
        return;
      }
      connection.remoteInputEnded = true;
      connection.socket.end();
    };

    const handleRemoteReset = (connId: number): void => {
      if (connections.has(connId)) {
        removeConnection(connId, true);
      }
    };

    const handleBinary = (frame: Buffer): void => {
      if (!tunnelReady) {
        throw new TunnelV2ProtocolError('received tunnel data before READY');
      }
      if (frame.length <= TUNNEL_V2_CONN_ID_HEADER_BYTES) {
        throw new TunnelV2ProtocolError('tunnel data frame must include a payload');
      }
      const connId = frame.readUInt32BE(0);
      const connection = findOpenConnection(connId);
      if (!connection) return;
      if (connection.remoteInputEnded) {
        sendReset(connId, 'protocol_error');
        removeConnection(connId, true);
        return;
      }

      const payload = frame.subarray(TUNNEL_V2_CONN_ID_HEADER_BYTES);
      const nextConnectionPendingBytes = connection.pendingWriteBytes + payload.length;
      const nextTotalPendingBytes = totalPendingWriteBytes + payload.length;
      if (
        nextConnectionPendingBytes > maxPendingBytesPerConnection ||
        nextTotalPendingBytes > maxTotalPendingBytes
      ) {
        sendReset(connId, 'resource_exhausted');
        removeConnection(connId, true);
        return;
      }

      connection.pendingWriteBytes = nextConnectionPendingBytes;
      totalPendingWriteBytes = nextTotalPendingBytes;
      connection.socket.write(payload, (error?: Error | null) => {
        connection.pendingWriteBytes -= payload.length;
        totalPendingWriteBytes -= payload.length;
        if (error && connections.get(connId) === connection) {
          const osCode = (error as NodeJS.ErrnoException).code;
          sendReset(connId, 'connection_error', osCode);
          removeConnection(connId, true);
        }
      });
    };

    const handleControl = (message: TunnelV2ServerMessage): void => {
      switch (message.type) {
        case 'ready':
          if (tunnelReady) throw new TunnelV2ProtocolError('received duplicate READY');
          assertTunnelV2Ready(message, routes);
          tunnelReady = true;
          if (handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = undefined;
          }
          armLivenessDeadline();
          updateConnectionState('connected');
          logger.info(`Destination tunnel ready with ${message.bindings.length} route(s)`);
          resolve({
            tunnelId: message.tunnelId,
            bindings: message.bindings,
            close,
            getConnectionState,
            onConnectionStateChange,
          });
          return;
        case 'error':
          throw new Error(`destination tunnel failed: ${message.code}`);
        case 'open':
          if (!tunnelReady) throw new TunnelV2ProtocolError('received OPEN before READY');
          handleOpen(message);
          return;
        case 'fin':
          if (!tunnelReady) throw new TunnelV2ProtocolError('received FIN before READY');
          handleRemoteFIN(message.connId);
          return;
        case 'reset':
          if (!tunnelReady) throw new TunnelV2ProtocolError('received RESET before READY');
          handleRemoteReset(message.connId);
      }
    };

    const armLivenessDeadline = (): void => {
      if (!tunnelReady || closed) return;
      if (livenessTimer) clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => {
        failTransport(new Error(`destination tunnel received no frames for ${livenessTimeoutMs}ms`));
      }, livenessTimeoutMs);
      livenessTimer.unref();
    };

    handshakeTimer = setTimeout(() => {
      failTransport(new Error(`destination tunnel was not ready within ${handshakeTimeoutMs}ms`));
    }, handshakeTimeoutMs);
    handshakeTimer.unref();

    ws.on('open', () => {
      sendControl({ type: 'start', version: TUNNEL_V2_VERSION, routes });
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping(undefined, true, frameSent);
          frameQueued();
        }
      }, pingIntervalMs);
      pingInterval.unref();
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      try {
        armLivenessDeadline();
        if (isBinary) {
          handleBinary(toBuffer(data));
        } else {
          handleControl(decodeTunnelV2ServerMessage(JSON.parse(toBuffer(data).toString('utf8'))));
        }
      } catch (error) {
        failTransport(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.on('ping', armLivenessDeadline);
    ws.on('pong', armLivenessDeadline);

    ws.once('error', (error: Error) => {
      failTransport(error);
    });

    ws.once('close', (code: number, reason: Buffer) => {
      if (closed) {
        ws.removeAllListeners();
        return;
      }
      failTransport(
        new Error(
          `destination tunnel WebSocket closed: ${code}${reason.length ? ` ${reason.toString()}` : ''}`,
        ),
      );
      ws.removeAllListeners();
    });
  });
}

export function classifyOpenFailure(error: NodeJS.ErrnoException): TunnelV2OpenFailureReason {
  switch (error.code) {
    case 'ENOTFOUND':
      return 'dns_not_found';
    case 'EAI_AGAIN':
      return 'dns_temporary_failure';
    case 'ECONNREFUSED':
      return 'connection_refused';
    case 'ECONNRESET':
      return 'connection_reset';
    case 'ETIMEDOUT':
      return 'connection_timed_out';
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return 'unreachable';
    case 'EACCES':
    case 'EPERM':
      return 'permission_denied';
    case 'EMFILE':
    case 'ENFILE':
    case 'ENOBUFS':
    case 'ENOMEM':
      return 'resource_exhausted';
    case 'ECANCELED':
      return 'cancelled';
    default:
      return 'internal';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TunnelV2ProtocolError('unsupported WebSocket payload type');
}
