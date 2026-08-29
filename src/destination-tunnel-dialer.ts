import dns from 'dns';
import net from 'net';
import tls from 'tls';
import { WebSocket, type RawData } from 'ws';
import { nodeProxyTransport } from './internal/proxy-transport';
import { toBuffer } from './internal/destination-tunnel-wire-reader';
import {
  startDestinationTunnelInspectionStream,
  type DestinationTunnelInspectionErrorCallback,
  type DestinationTunnelInspectionEventCallback,
  type DestinationTunnelInspectionStream,
} from './destination-tunnel-inspection';
import {
  DESTINATION_TUNNEL_DEFAULT_WINDOW,
  DESTINATION_TUNNEL_VERSION,
  DestinationTunnelProtocolError,
  assertDestinationTunnelOpenAllowed,
  assertDestinationTunnelReady,
  classifyDestinationTunnelSelectors,
  decodeDestinationTunnelDataFrame,
  decodeDestinationTunnelServerMessage,
  disabledDestinationTunnelInspection,
  destinationTunnelConfigHash,
  encodeDestinationTunnelDataFrame,
  encodeDestinationTunnelClientMessage,
  normalizeDestinationTunnelInspection,
  validateDestinationTunnelSelectors,
  type DestinationTunnelClientMessage,
  type DestinationTunnelOpenFailureReason,
  type DestinationTunnelInspectionConfig,
  type DestinationTunnelRoute,
  type DestinationTunnelResetReason,
  type DestinationTunnelSelectorReport,
  type DestinationTunnelSelectors,
  type DestinationTunnelServerMessage,
} from './destination-tunnel';
import type { LogLevel, TunnelConnectionState, TunnelConnectionStateCallback } from './tunnel';

const blockedResolvedAddresses = new net.BlockList();
blockedResolvedAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
blockedResolvedAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
blockedResolvedAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
blockedResolvedAddresses.addSubnet('224.0.0.0', 3, 'ipv4');
blockedResolvedAddresses.addSubnet('::', 96, 'ipv6');
blockedResolvedAddresses.addSubnet('fe80::', 10, 'ipv6');
blockedResolvedAddresses.addSubnet('ff00::', 8, 'ipv6');
blockedResolvedAddresses.addSubnet('::ffff:0.0.0.0', 104, 'ipv6');
blockedResolvedAddresses.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
blockedResolvedAddresses.addSubnet('::ffff:169.254.0.0', 112, 'ipv6');
blockedResolvedAddresses.addSubnet('::ffff:224.0.0.0', 99, 'ipv6');

export interface DestinationTcpTunnel {
  tunnelId: string;
  /** Normalized selectors echoed by the server, including bind reports. */
  selectors: DestinationTunnelSelectorReport[];
  configHash: string;
  inspection: DestinationTunnelInspectionConfig;
  inspectionStream?: DestinationTunnelInspectionStream;
  close: () => void;
  getConnectionState: () => TunnelConnectionState;
  onConnectionStateChange: (callback: TunnelConnectionStateCallback) => () => void;
}

export interface DestinationTcpTunnelOptions {
  selectors: DestinationTunnelSelectors;
  inspection?: Partial<DestinationTunnelInspectionConfig>;
  /** Called for validated inspection metadata and body frames. */
  onInspectionEvent?: DestinationTunnelInspectionEventCallback;
  /** Called for inspection-only transport, protocol, or callback failures. */
  onInspectionError?: DestinationTunnelInspectionErrorCallback;
  /** Per-flow receive window in bytes. Defaults to 1 MiB. */
  window?: number;
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
  socket?: net.Socket;
  phase: 'connecting' | 'open';
  abortController: AbortController;
  connectTimer: NodeJS.Timeout;
  localInputEnded: boolean;
  remoteInputEnded: boolean;
  pendingWriteBytes: number;
  /** Bytes we may still send toward the server. */
  sendCredit: number;
  /** Chunks read from the local socket awaiting send credit, FIFO. */
  creditQueue: Buffer[];
  creditQueueBytes: number;
  /** Local socket ended while chunks were still queued; send fin after they drain. */
  finPending: boolean;
  /** Bytes accepted by the local socket since the last windowUpdate we sent. */
  deliveredSinceUpdate: number;
  dnsMs?: number;
}

interface OpenDialConnection extends DialConnection {
  socket: net.Socket;
  phase: 'open';
}

/** Thrown (message prefix) when the server terminates the session with `error`. */
export const DESTINATION_TUNNEL_SERVER_ERROR_PREFIX = 'destination tunnel failed: ';

/**
 * True when the failure is a terminal protocol/policy rejection from the
 * server rather than a transient transport problem. Reconnect supervisors
 * must not retry terminal failures.
 */
export function isTerminalDestinationTunnelError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(DESTINATION_TUNNEL_SERVER_ERROR_PREFIX);
}

export async function startDestinationTcpTunnel(
  remoteURL: string,
  token: string,
  options: DestinationTcpTunnelOptions,
): Promise<DestinationTcpTunnel> {
  const selectors = validateDestinationTunnelSelectors(options.selectors);
  const routes = classifyDestinationTunnelSelectors(selectors).routes ?? [];
  const inspection = normalizeDestinationTunnelInspection(
    options.inspection ?? disabledDestinationTunnelInspection(),
  );
  const logLevel = options.logLevel ?? 'info';
  const creditWindow = positiveInteger(options.window ?? DESTINATION_TUNNEL_DEFAULT_WINDOW, 'window');
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
    let inspectionStream: DestinationTunnelInspectionStream | undefined;
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
      connection.abortController.abort();
      clearTimeout(connection.connectTimer);
      markRecentlyClosed(connId);
      if (destroySocket && connection.socket && !connection.socket.destroyed) {
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
      inspectionStream?.close();
      inspectionStream = undefined;
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

    const mayReadFromSocket = (connection: DialConnection): boolean =>
      !pausedForBackpressure && connection.creditQueueBytes === 0;

    const pauseForBackpressure = (): void => {
      if (pausedForBackpressure) return;
      pausedForBackpressure = true;
      for (const connection of connections.values()) {
        if (connection.socket && !connection.socket.destroyed) connection.socket.pause();
      }
    };

    const resumeIfDrained = (): void => {
      if (!pausedForBackpressure || ws.bufferedAmount >= resumeBelowBufferedBytes) return;
      pausedForBackpressure = false;
      for (const connection of connections.values()) {
        // Flows still waiting on per-flow credit stay paused; they resume
        // when the server grants more window, keeping one stalled flow from
        // holding every other flow back.
        if (connection.socket && !connection.socket.destroyed && mayReadFromSocket(connection)) {
          connection.socket.resume();
        }
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

    const sendControl = (message: DestinationTunnelClientMessage): void => {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        failTransport(new Error('destination tunnel WebSocket is not open'));
        return;
      }
      ws.send(encodeDestinationTunnelClientMessage(message), frameSent);
      frameQueued();
    };

    const sendData = (connId: number, payload: Buffer): void => {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        failTransport(new Error('destination tunnel WebSocket closed while sending data'));
        return;
      }
      ws.send(encodeDestinationTunnelDataFrame(connId, payload), { binary: true }, frameSent);
      frameQueued();
    };

    const sendOpenFailure = (
      connId: number,
      reason: DestinationTunnelOpenFailureReason,
      osCode?: string,
    ): void => {
      sendControl({
        type: 'openFail',
        connId,
        reason,
        ...(osCode ? { osCode } : {}),
      });
      markRecentlyClosed(connId);
    };

    const sendReset = (connId: number, reason: DestinationTunnelResetReason, osCode?: string): void => {
      sendControl({
        type: 'reset',
        connId,
        reason,
        ...(osCode ? { osCode } : {}),
      });
    };

    /**
     * Push local socket bytes toward the server through the per-flow credit
     * gate. Chunks beyond the current credit wait in a FIFO queue with the
     * local socket paused, so a server-throttled flow stops reading instead
     * of buffering unboundedly.
     */
    const pushThroughCreditGate = (connId: number, connection: DialConnection, payload?: Buffer): void => {
      if (payload && payload.length > 0) {
        connection.creditQueue.push(payload);
        connection.creditQueueBytes += payload.length;
      }
      while (connection.creditQueue.length > 0 && connection.sendCredit > 0) {
        const chunk = connection.creditQueue[0]!;
        if (chunk.length <= connection.sendCredit) {
          connection.creditQueue.shift();
          connection.creditQueueBytes -= chunk.length;
          connection.sendCredit -= chunk.length;
          sendData(connId, chunk);
        } else {
          const portion = chunk.subarray(0, connection.sendCredit);
          connection.creditQueue[0] = chunk.subarray(connection.sendCredit);
          connection.creditQueueBytes -= portion.length;
          connection.sendCredit = 0;
          sendData(connId, portion);
        }
        if (closed) return;
      }
      if (connection.creditQueue.length === 0 && connection.finPending) {
        // The local socket ended while data was still waiting on credit; the
        // queue has drained, so half-close can now be signaled in order.
        connection.finPending = false;
        connection.localInputEnded = true;
        sendControl({ type: 'fin', connId });
      }
      if (!connection.socket || connection.socket.destroyed) return;
      if (connection.creditQueueBytes > 0) {
        connection.socket.pause();
      } else if (!pausedForBackpressure) {
        connection.socket.resume();
      }
    };

    const dialTarget = async (
      message: Extract<DestinationTunnelServerMessage, { type: 'open' }>,
    ): Promise<{ host: string; dnsMs: number }> => {
      // Domain selectors resolve through the user's OS resolver and may only
      // reach ordinary unicast targets. Loopback and similar special targets
      // require an explicit exact route grant.
      const startedAt = Date.now();
      const results = await dns.promises.lookup(message.host, { all: true, verbatim: true });
      const dnsMs = Date.now() - startedAt;
      for (const result of results) {
        if (isDialableResolvedAddress(result.address, message.port, routes)) {
          return { host: result.address, dnsMs };
        }
      }
      const blockedError: NodeJS.ErrnoException = new Error(
        `all resolved addresses for ${message.host} are blocked`,
      );
      blockedError.code = 'EBLOCKED';
      throw blockedError;
    };

    const wrapTls = (
      socket: net.Socket,
      transport: Extract<DestinationTunnelServerMessage, { type: 'open' }>['transport'] & {
        type: 'tls';
      },
      abortController: AbortController,
    ): Promise<tls.TLSSocket> =>
      new Promise((resolveTls, rejectTls) => {
        const tlsSocket = tls.connect({
          socket,
          rejectUnauthorized: true,
          servername: transport.serverName,
          ALPNProtocols: transport.alpnProtocols,
        });
        tlsSocket.allowHalfOpen = true;
        const cleanup = (): void => {
          tlsSocket.removeListener('secureConnect', onSecureConnect);
          tlsSocket.removeListener('error', onError);
          abortController.signal.removeEventListener('abort', onAbort);
        };
        const onSecureConnect = (): void => {
          cleanup();
          tlsSocket.pause();
          resolveTls(tlsSocket);
        };
        const onError = (error: Error): void => {
          cleanup();
          rejectTls(error);
        };
        const onAbort = (): void => {
          cleanup();
          tlsSocket.destroy();
          rejectTls(Object.assign(new Error('TLS connection cancelled'), { code: 'ECANCELED' }));
        };
        tlsSocket.once('secureConnect', onSecureConnect);
        tlsSocket.once('error', onError);
        if (abortController.signal.aborted) {
          onAbort();
        } else {
          abortController.signal.addEventListener('abort', onAbort, { once: true });
        }
      });

    const handleOpen = (message: Extract<DestinationTunnelServerMessage, { type: 'open' }>): void => {
      let kind: 'route' | 'domain';
      try {
        kind = assertDestinationTunnelOpenAllowed(message, selectors);
      } catch {
        sendOpenFailure(message.connId, 'selector_not_allowed');
        return;
      }
      if (connections.has(message.connId) || recentlyClosed.has(message.connId)) {
        throw new DestinationTunnelProtocolError(`server reused connection ID ${message.connId}`);
      }
      if (connections.size >= maxConnections) {
        sendOpenFailure(message.connId, 'resource_exhausted');
        return;
      }

      const abortController = new AbortController();
      const connectTimer = setTimeout(() => {
        if (connections.get(message.connId)?.phase !== 'connecting') return;
        logger.warn(`Failed to connect to ${message.host}:${message.port}: timed out`);
        sendOpenFailure(message.connId, 'connection_timed_out', 'ETIMEDOUT');
        removeConnection(message.connId, true);
      }, connectTimeoutMs);
      connectTimer.unref();
      const connection: DialConnection = {
        phase: 'connecting',
        abortController,
        connectTimer,
        localInputEnded: false,
        remoteInputEnded: false,
        pendingWriteBytes: 0,
        sendCredit: message.window,
        creditQueue: [],
        creditQueueBytes: 0,
        finPending: false,
        deliveredSinceUpdate: 0,
      };
      connections.set(message.connId, connection);

      void (async () => {
        let host = message.host;
        if (kind === 'domain') {
          const resolved = await dialTarget(message);
          host = resolved.host;
          connection.dnsMs = resolved.dnsMs;
        }
        if (connections.get(message.connId) !== connection || closed) return;

        const tcp = await nodeProxyTransport.connectTcp({
          host,
          port: message.port,
          proxyLookupHost: message.host,
          proxyLookupProtocol: message.transport.type === 'tls' ? 'https:' : 'http:',
          timeoutMs: connectTimeoutMs,
          signal: abortController.signal,
        });
        if (connections.get(message.connId) !== connection || closed) {
          tcp.socket.destroy();
          return;
        }
        connection.socket = tcp.socket;

        let socket: net.Socket = tcp.socket;
        let tlsMs: number | undefined;
        if (message.transport.type === 'tls') {
          const tlsStartedAt = Date.now();
          socket = await wrapTls(tcp.socket, message.transport, abortController);
          tlsMs = Date.now() - tlsStartedAt;
          if (connections.get(message.connId) !== connection || closed) {
            socket.destroy();
            return;
          }
          connection.socket = socket;
        }

        clearTimeout(connectTimer);
        socket.on('data', (payload: Buffer) => {
          if (connections.get(message.connId) !== connection || connection.phase !== 'open') return;
          pushThroughCreditGate(message.connId, connection, payload);
        });
        socket.once('end', () => {
          if (connections.get(message.connId) !== connection || connection.phase !== 'open') return;
          if (connection.creditQueueBytes > 0) {
            // Queued bytes are still waiting on send credit; fin must follow
            // them, so defer it until the credit gate drains the queue.
            connection.finPending = true;
            return;
          }
          connection.localInputEnded = true;
          sendControl({ type: 'fin', connId: message.connId });
        });
        socket.once('error', (error: NodeJS.ErrnoException) => {
          if (connections.get(message.connId) !== connection) return;
          sendReset(message.connId, 'connection_error', error.code);
          removeConnection(message.connId, true);
        });
        socket.once('close', () => {
          if (connections.get(message.connId) !== connection) return;
          if (!connection.localInputEnded || !connection.remoteInputEnded) {
            sendReset(message.connId, 'connection_error');
          }
          removeConnection(message.connId, false);
        });

        connection.phase = 'open';
        sendControl({
          type: 'openOk',
          connId: message.connId,
          transport: {
            type: message.transport.type,
            ...(tcp.remoteAddress === undefined ? {} : { remoteAddress: tcp.remoteAddress }),
            ...(connection.dnsMs === undefined ? {} : { dnsMs: connection.dnsMs }),
            connectMs: tcp.connectMs,
            ...(tlsMs === undefined ? {} : { tlsMs }),
            ...(socket instanceof tls.TLSSocket && socket.alpnProtocol ?
              { alpnProtocol: socket.alpnProtocol }
            : {}),
          },
          window: creditWindow,
        });
        logger.debug(`Forwarding connection ${message.connId} to ${message.host}:${message.port}`);
        if (!pausedForBackpressure && connection.creditQueueBytes === 0) socket.resume();
      })().catch((error: NodeJS.ErrnoException) => {
        if (connections.get(message.connId) !== connection) return;
        logger.warn(`Failed to connect to ${message.host}:${message.port}: ${error.code ?? error.message}`);
        const reason = error.code === 'EBLOCKED' ? 'selector_not_allowed' : classifyOpenFailure(error);
        sendOpenFailure(message.connId, reason, error.code === 'EBLOCKED' ? undefined : error.code);
        removeConnection(message.connId, true);
      });
    };

    const findOpenConnection = (connId: number): OpenDialConnection | undefined => {
      const connection = connections.get(connId);
      if (connection?.phase === 'open' && connection.socket) return connection as OpenDialConnection;
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

    const handleRemoteWindowUpdate = (connId: number, increment: number): void => {
      const connection = connections.get(connId);
      // Updates racing a local close are expected; ignore unknown flows.
      if (!connection || connection.phase !== 'open') return;
      connection.sendCredit += increment;
      pushThroughCreditGate(connId, connection);
    };

    const handleBinary = (frame: Buffer): void => {
      if (!tunnelReady) {
        throw new DestinationTunnelProtocolError('received tunnel data before READY');
      }
      const { connId, payload } = decodeDestinationTunnelDataFrame(frame);
      const connection = findOpenConnection(connId);
      if (!connection) return;
      if (connection.remoteInputEnded) {
        sendReset(connId, 'protocol_error');
        removeConnection(connId, true);
        return;
      }

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
          return;
        }
        // Replenish the server's send window once the local socket accepted
        // the bytes, batching updates to roughly half the window.
        if (connections.get(connId) !== connection) return;
        connection.deliveredSinceUpdate += payload.length;
        if (connection.deliveredSinceUpdate >= Math.ceil(creditWindow / 2)) {
          const increment = connection.deliveredSinceUpdate;
          connection.deliveredSinceUpdate = 0;
          if (!closed && ws.readyState === WebSocket.OPEN) {
            sendControl({ type: 'windowUpdate', connId, increment });
          }
        }
      });
    };

    const handleControl = (message: DestinationTunnelServerMessage): void => {
      switch (message.type) {
        case 'ready': {
          if (tunnelReady) throw new DestinationTunnelProtocolError('received duplicate READY');
          assertDestinationTunnelReady(message);
          const expected = destinationTunnelConfigHash(selectors, inspection);
          if (message.configHash !== expected) {
            throw new DestinationTunnelProtocolError(
              `server acknowledged config ${message.configHash} but ${expected} was negotiated`,
            );
          }
          tunnelReady = true;
          if (handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = undefined;
          }
          armLivenessDeadline();
          updateConnectionState('connected');
          logger.info(`Destination tunnel ready with ${selectors.length} selector(s)`);
          if (inspection.enabled) {
            try {
              inspectionStream = startDestinationTunnelInspectionStream(remoteURL, message.tunnelId, token, {
                ...(options.onInspectionEvent ? { onEvent: options.onInspectionEvent } : {}),
                ...(options.onInspectionError ? { onError: options.onInspectionError } : {}),
              });
            } catch (error) {
              try {
                options.onInspectionError?.(error instanceof Error ? error : new Error(String(error)));
              } catch {
                // Inspection callbacks are isolated from the main tunnel.
              }
            }
          }
          resolve({
            tunnelId: message.tunnelId,
            selectors: message.selectors,
            configHash: message.configHash,
            inspection,
            ...(inspectionStream ? { inspectionStream } : {}),
            close,
            getConnectionState,
            onConnectionStateChange,
          });
          return;
        }
        case 'error':
          throw new Error(`${DESTINATION_TUNNEL_SERVER_ERROR_PREFIX}${message.code}`);
        case 'open':
          if (!tunnelReady) throw new DestinationTunnelProtocolError('received OPEN before READY');
          handleOpen(message);
          return;
        case 'fin':
          if (!tunnelReady) throw new DestinationTunnelProtocolError('received FIN before READY');
          handleRemoteFIN(message.connId);
          return;
        case 'windowUpdate':
          if (!tunnelReady) throw new DestinationTunnelProtocolError('received windowUpdate before READY');
          handleRemoteWindowUpdate(message.connId, message.increment);
          return;
        case 'reset':
          if (!tunnelReady) throw new DestinationTunnelProtocolError('received RESET before READY');
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
      sendControl({
        type: 'start',
        version: DESTINATION_TUNNEL_VERSION,
        selectors,
        inspection,
        window: creditWindow,
      });
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
          handleControl(decodeDestinationTunnelServerMessage(JSON.parse(toBuffer(data).toString('utf8'))));
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

/**
 * Whether a resolved domain address may be dialed. Ordinary unicast targets
 * (including private ranges the user's machine can reach) are allowed;
 * loopback, link-local, multicast, unspecified, broadcast, and similar
 * special targets are blocked unless an exact route grants them.
 */
export function isDialableResolvedAddress(
  address: string,
  port: number,
  routes: readonly DestinationTunnelRoute[],
): boolean {
  for (const route of routes) {
    if (route.port !== port) continue;
    if (route.host === address) return true;
    if (route.host === 'localhost' && (address === '127.0.0.1' || address === '::1')) return true;
  }
  const version = net.isIP(address);
  if (version === 4) return !blockedResolvedAddresses.check(address, 'ipv4');
  if (version === 6) return !blockedResolvedAddresses.check(address, 'ipv6');
  return false;
}

export function classifyOpenFailure(error: NodeJS.ErrnoException): DestinationTunnelOpenFailureReason {
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
    case 'EPROXYAUTH':
      return 'permission_denied';
    case 'EMFILE':
    case 'ENFILE':
    case 'ENOBUFS':
    case 'ENOMEM':
      return 'resource_exhausted';
    case 'ECANCELED':
      return 'cancelled';
    case 'CERT_HAS_EXPIRED':
    case 'CERT_NOT_YET_VALID':
    case 'CERT_REJECTED':
    case 'CERT_REVOKED':
    case 'CERT_SIGNATURE_FAILURE':
    case 'CERT_UNTRUSTED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'ERR_TLS_CERT_ALTNAME_FORMAT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'HOSTNAME_MISMATCH':
    case 'INVALID_CA':
    case 'INVALID_PURPOSE':
    case 'PATH_LENGTH_EXCEEDED':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'tls_validation_failed';
    case 'EPROTO':
      return 'tls_protocol_error';
    default:
      if (error.code?.startsWith('ERR_SSL_') || error.code?.startsWith('ERR_TLS_')) {
        return 'tls_handshake_failed';
      }
      return 'internal';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
