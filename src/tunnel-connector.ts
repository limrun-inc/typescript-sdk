import os from 'os';
import { WebSocket, type RawData } from 'ws';
import { nodeProxyTransport } from './internal/proxy-transport';
import { deriveDestinationTunnelURL } from './internal/destination-tunnel-url';
import {
  getDestinationTunnelStatus,
  stopDestinationTunnel,
  type DestinationTunnelStatus,
} from './internal/destination-tunnel-management';
import {
  DestinationTunnelProtocolError,
  readInteger,
  readNonEmptyString,
  readOptionalString,
  readRecord,
  readString,
  toBuffer,
} from './internal/destination-tunnel-wire-reader';
import {
  DESTINATION_TUNNEL_SERVER_ERROR_PREFIX,
  destinationTunnelDialOptions,
  isTerminalDestinationTunnelError,
  startDestinationTcpTunnel,
  type DestinationTcpTunnel,
} from './destination-tunnel-dialer';
import {
  normalizeDestinationTunnelInspection,
  validateDestinationTunnelSelectors,
  type DestinationTunnelInspectionConfig,
  type DestinationTunnelSelectors,
} from './destination-tunnel';
import type { LogLevel } from './tunnel';
import { VERSION } from './version';

const CONTROL_PROTOCOL_VERSION = 1;
const CONTROL_PING_INTERVAL_MS = 15_000;
const CONTROL_DEAD_PEER_MS = 45_000;
const CONTROL_INITIAL_BACKOFF_MS = 500;
const CONTROL_MAX_BACKOFF_MS = 10_000;
const BYE_GRACE_MS = 1_000;
const ATTACH_INITIAL_BACKOFF_MS = 1_000;
const ATTACH_MAX_BACKOFF_MS = 30_000;
/** Every tunnel WebSocket counts as instance activity, so retries must end. */
const ATTACH_GIVE_UP_MS = 5 * 60_000;
const TAKEN_OVER_MESSAGE = 'another connector for this tunnel took the instance over';

export interface TunnelConnectorOptions {
  apiKey: string;
  /** Limrun API base URL, such as https://api.limrun.com. */
  baseURL: string;
  organizationId: string;
  /** The name instances set in `spec.tunnel` to attach to this connector. */
  name: string;
  selectors: DestinationTunnelSelectors;
  /** Inspection for every instance tunnel. Defaults to enabled without bodies. */
  inspection?: Partial<DestinationTunnelInspectionConfig>;
  /** Take the name over from the connector that holds it now. */
  replace?: boolean;
  /** Identifies this connector to the platform. Defaults to the OS hostname. */
  hostname?: string;
  /** Reported to the platform. Defaults to the SDK version. */
  clientVersion?: string;
  /** Log level of the per-instance tunnels. Defaults to 'warn'. */
  logLevel?: LogLevel;
  onEvent?: (event: TunnelConnectorEvent) => void;
}

export type TunnelConnectorEvent =
  /** This connector holds the name; emitted once per session and control connection. */
  | { type: 'active'; sessionId: string }
  /** Another connector holds the name; emitted once per holder. */
  | { type: 'standby'; holder: { hostname: string; since?: string } }
  | { type: 'attached'; instanceId: string; tunnelId: string }
  /** The connector gave up on the instance. */
  | { type: 'attachFailed'; instanceId: string; code: string; message: string }
  | { type: 'detached'; instanceId: string; reason: string }
  | { type: 'notice'; code: string; message: string; instanceId?: string }
  /** The control channel, or the tunnel of `instanceId`, retries after `delayMs`. */
  | { type: 'reconnecting'; instanceId?: string; delayMs: number; reason: string };

export interface TunnelConnector {
  /** Resolves after close() and rejects with the terminal error that ended the connector. */
  closed: Promise<void>;
  /** Releases the name at once, closes every instance tunnel, and resolves when done. */
  close: () => Promise<void>;
}

type ControlClientMessage =
  | {
      type: 'hello';
      version: number;
      selectors: DestinationTunnelSelectors;
      replace: boolean;
      sessionId?: string;
      attached: string[];
      client: { hostname: string; cliVersion: string };
    }
  | { type: 'attached'; instanceId: string; tunnelId: string }
  | { type: 'attachFailed'; instanceId: string; code: string; message: string; terminal: boolean }
  | { type: 'bye' };

type ControlServerMessage =
  | { type: 'active'; sessionId: string; leaseSeconds: number }
  | { type: 'standby'; holder: { hostname: string; since?: string } }
  | { type: 'attach'; instanceId: string; url: string; token: string }
  | { type: 'detach'; instanceId: string; reason: string }
  | { type: 'notice'; code: string; message: string; instanceId?: string }
  | { type: 'revoked'; reason: string };

interface InstanceAttachment {
  /** Instance base URL: the iOS API URL or the Android ADB WebSocket URL. */
  url: string;
  token: string;
  tunnel?: DestinationTcpTunnel | undefined;
  /** This connector's latest tunnel on the instance, live or dropped. */
  lastTunnelId?: string;
  /** A stale tunnel of a dead predecessor may be stopped once, before the first attach. */
  mayReclaim: boolean;
  /** Start of the current failure streak, which ends in attach_timeout after five minutes. */
  failingSince: number;
  backoffMs: number;
  retryTimer?: NodeJS.Timeout | undefined;
  /** Detached, given up, or closed: results that arrive later are discarded. */
  done: boolean;
}

/**
 * Serve a persistent tunnel: hold the name through one control WebSocket to
 * the Limrun API and open a destination tunnel to every instance created
 * with `spec.tunnel` set to it. Instance tunnels stay up while the control
 * channel reconnects, so an API outage never becomes a tunnel outage.
 */
export function connectTunnel(options: TunnelConnectorOptions): TunnelConnector {
  const selectors = validateDestinationTunnelSelectors(options.selectors);
  const dialOptions = {
    ...destinationTunnelDialOptions(
      { selectors, ...(options.inspection ? { inspection: options.inspection } : {}) },
      options.logLevel ?? 'warn',
    ),
    name: options.name,
  };
  // Reject a bad inspection config now rather than on every attach.
  normalizeDestinationTunnelInspection(dialOptions.inspection ?? {});
  const controlURL = deriveTunnelConnectURL(options.baseURL, options.organizationId, options.name);
  const client = {
    hostname: options.hostname ?? os.hostname(),
    cliVersion: options.clientVersion ?? VERSION,
  };

  const instances = new Map<string, InstanceAttachment>();
  let ws: WebSocket | undefined;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let controlBackoffMs = CONTROL_INITIAL_BACKOFF_MS;
  let sessionId: string | undefined;
  // --replace takes the name over once; afterwards this connector resumes
  // like any holder and never steals the name back.
  let claimed = false;
  let lastActiveAt = 0;
  let leaseMs = 0;
  let announcedSession: string | undefined;
  let announcedHolder: string | undefined;

  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Callers that never await `closed` must not crash on a terminal error.
  closed.catch(() => {});

  const emit = (event: TunnelConnectorEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Event callbacks are isolated from the connector.
    }
  };

  // Messages sent while the control channel is down are dropped; the hello of
  // the next connection reports which instances are attached.
  const send = (message: ControlClientMessage): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const isConfirmedHolder = (): boolean => lastActiveAt > 0 && Date.now() - lastActiveAt < leaseMs;

  const forget = (instanceId: string, attachment: InstanceAttachment): void => {
    const tunnel = attachment.tunnel;
    attachment.tunnel = undefined;
    attachment.done = true;
    if (attachment.retryTimer) clearTimeout(attachment.retryTimer);
    tunnel?.close();
    if (instances.get(instanceId) === attachment) instances.delete(instanceId);
  };

  const forgetAll = (): void => {
    for (const [instanceId, attachment] of Array.from(instances)) forget(instanceId, attachment);
  };

  const fail = (detail: string): void => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    forgetAll();
    ws?.terminate();
    rejectClosed(new Error(`tunnel ${options.name}: ${detail}`));
  };

  const giveUp = (
    instanceId: string,
    attachment: InstanceAttachment,
    code: string,
    message: string,
  ): void => {
    forget(instanceId, attachment);
    send({ type: 'attachFailed', instanceId, code, message, terminal: true });
    emit({ type: 'attachFailed', instanceId, code, message });
  };

  const scheduleAttachRetry = (instanceId: string, attachment: InstanceAttachment, reason: string): void => {
    const delayMs = jittered(attachment.backoffMs);
    attachment.backoffMs = Math.min(attachment.backoffMs * 2, ATTACH_MAX_BACKOFF_MS);
    emit({ type: 'reconnecting', instanceId, delayMs, reason });
    attachment.retryTimer = setTimeout(() => void attach(instanceId, attachment), delayMs);
  };

  const retryAfterFailure = (
    instanceId: string,
    attachment: InstanceAttachment,
    code: string,
    message: string,
  ): void => {
    if (Date.now() - attachment.failingSince >= ATTACH_GIVE_UP_MS) {
      giveUp(instanceId, attachment, 'attach_timeout', `could not attach within 5 minutes: ${message}`);
      return;
    }
    send({ type: 'attachFailed', instanceId, code, message, terminal: false });
    scheduleAttachRetry(instanceId, attachment, message);
  };

  // A drop with a same-name tunnel of another ID now active means another
  // holder took the instance over. Yielding keeps two connectors from
  // superseding each other forever.
  const takenOver = async (attachment: InstanceAttachment): Promise<boolean> => {
    try {
      const active = (await getDestinationTunnelStatus(attachment.url, attachment.token)).active;
      return active?.name === options.name && active.tunnelId !== attachment.lastTunnelId;
    } catch {
      // The dial that follows surfaces a real failure.
      return false;
    }
  };

  const resolveAlreadyActive = async (instanceId: string, attachment: InstanceAttachment): Promise<void> => {
    let active: DestinationTunnelStatus['active'];
    try {
      active = (await getDestinationTunnelStatus(attachment.url, attachment.token)).active;
    } catch (error) {
      if (!attachment.done) retryAfterFailure(instanceId, attachment, 'already_active', errorMessage(error));
      return;
    }
    if (attachment.done) return;
    if (!active || active.tunnelId === attachment.lastTunnelId) {
      retryAfterFailure(instanceId, attachment, 'already_active', 'the previous tunnel is still stopping');
      return;
    }
    if (active.name !== options.name) {
      giveUp(instanceId, attachment, 'instance_busy', 'the instance already has another tunnel');
      return;
    }
    // Only the confirmed holder may stop a same-name tunnel, and only once:
    // it can then belong to nobody but a dead predecessor.
    if (attachment.mayReclaim && isConfirmedHolder()) {
      attachment.mayReclaim = false;
      try {
        await stopDestinationTunnel(attachment.url, attachment.token, active.tunnelId);
      } catch {
        // The retry below reports a tunnel that is still there.
      }
      if (!attachment.done) void attach(instanceId, attachment);
      return;
    }
    giveUp(instanceId, attachment, 'taken_over', TAKEN_OVER_MESSAGE);
  };

  const attach = async (instanceId: string, attachment: InstanceAttachment): Promise<void> => {
    attachment.retryTimer = undefined;
    let tunnel: DestinationTcpTunnel;
    try {
      if (attachment.lastTunnelId !== undefined && (await takenOver(attachment))) {
        if (!attachment.done) {
          giveUp(instanceId, attachment, 'taken_over', TAKEN_OVER_MESSAGE);
        }
        return;
      }
      if (attachment.done) return;
      tunnel = await startDestinationTcpTunnel(
        deriveDestinationTunnelURL(attachment.url),
        attachment.token,
        dialOptions,
      );
    } catch (error) {
      if (attachment.done) return;
      if (upgradeStatus(error) === 404) {
        giveUp(instanceId, attachment, 'instance_gone', 'the instance is gone or terminating');
      } else if (!isTerminalDestinationTunnelError(error)) {
        retryAfterFailure(instanceId, attachment, 'connect_failed', errorMessage(error));
      } else {
        const code = errorMessage(error).slice(DESTINATION_TUNNEL_SERVER_ERROR_PREFIX.length);
        if (code === 'already_active') {
          await resolveAlreadyActive(instanceId, attachment);
        } else {
          giveUp(instanceId, attachment, code, `the instance rejected the tunnel: ${code}`);
        }
      }
      return;
    }
    if (attachment.done) {
      tunnel.close();
      return;
    }
    attachment.tunnel = tunnel;
    attachment.lastTunnelId = tunnel.tunnelId;
    attachment.mayReclaim = false;
    attachment.backoffMs = ATTACH_INITIAL_BACKOFF_MS;
    tunnel.onConnectionStateChange((state) => {
      if (state !== 'disconnected' || attachment.tunnel !== tunnel) return;
      attachment.tunnel = undefined;
      attachment.failingSince = Date.now();
      scheduleAttachRetry(instanceId, attachment, 'the instance tunnel disconnected');
    });
    send({ type: 'attached', instanceId, tunnelId: tunnel.tunnelId });
    emit({ type: 'attached', instanceId, tunnelId: tunnel.tunnelId });
  };

  const handleMessage = (message: ControlServerMessage): void => {
    switch (message.type) {
      case 'active':
        claimed = true;
        lastActiveAt = Date.now();
        leaseMs = message.leaseSeconds * 1000;
        controlBackoffMs = CONTROL_INITIAL_BACKOFF_MS;
        sessionId = message.sessionId;
        announcedHolder = undefined;
        if (announcedSession !== message.sessionId) {
          announcedSession = message.sessionId;
          emit({ type: 'active', sessionId: message.sessionId });
        }
        return;
      case 'standby': {
        lastActiveAt = 0;
        controlBackoffMs = CONTROL_INITIAL_BACKOFF_MS;
        sessionId = undefined;
        announcedSession = undefined;
        const holder = `${message.holder.hostname}\0${message.holder.since ?? ''}`;
        if (announcedHolder !== holder) {
          announcedHolder = holder;
          emit({ type: 'standby', holder: message.holder });
        }
        return;
      }
      case 'attach': {
        const existing = instances.get(message.instanceId);
        if (existing) {
          // Resume replays attaches; a live tunnel only needs confirming.
          existing.url = message.url;
          existing.token = message.token;
          if (existing.tunnel) {
            send({ type: 'attached', instanceId: message.instanceId, tunnelId: existing.tunnel.tunnelId });
          }
          return;
        }
        const attachment: InstanceAttachment = {
          url: message.url,
          token: message.token,
          mayReclaim: true,
          failingSince: Date.now(),
          backoffMs: ATTACH_INITIAL_BACKOFF_MS,
          done: false,
        };
        instances.set(message.instanceId, attachment);
        void attach(message.instanceId, attachment);
        return;
      }
      case 'detach': {
        const attachment = instances.get(message.instanceId);
        if (!attachment) return;
        forget(message.instanceId, attachment);
        emit({ type: 'detached', instanceId: message.instanceId, reason: message.reason });
        return;
      }
      case 'notice':
        emit(message);
        return;
      case 'revoked':
        fail(revokedMessage(message.reason));
    }
  };

  const scheduleReconnect = (reason: string, prompt: boolean): void => {
    if (stopped) return;
    const delayMs = jittered(prompt ? CONTROL_INITIAL_BACKOFF_MS : controlBackoffMs);
    if (!prompt) controlBackoffMs = Math.min(controlBackoffMs * 2, CONTROL_MAX_BACKOFF_MS);
    emit({ type: 'reconnecting', delayMs, reason });
    reconnectTimer = setTimeout(connectControl, delayMs);
  };

  const handleClose = (code: number, reason: string): void => {
    const detail = reason ? `: ${reason}` : '';
    switch (code) {
      case 1000:
        fail(`the server ended the session${detail}`);
        return;
      case 1012:
      case 1013:
        scheduleReconnect(`the server asked to reconnect (${code})`, true);
        return;
      case 4400:
        fail(`the server rejected the connector${detail}`);
        return;
      case 4404:
        fail('the tunnel was deleted');
        return;
      case 4409:
        fail(`the tunnel was revoked${detail}`);
        return;
      default:
        scheduleReconnect(`the control connection closed (${code}${detail})`, false);
    }
  };

  const connectControl = (): void => {
    reconnectTimer = undefined;
    if (stopped) return;
    const proxyAgent = nodeProxyTransport.getWebSocketAgent(controlURL);
    const socket = new WebSocket(controlURL, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      ...(proxyAgent ? { agent: proxyAgent } : {}),
      perMessageDeflate: false,
    });
    ws = socket;
    announcedSession = undefined;
    let pingInterval: NodeJS.Timeout | undefined;
    let livenessTimer: NodeJS.Timeout | undefined;
    let rejectedStatus: number | undefined;
    let lastError: string | undefined;

    const armLiveness = (): void => {
      if (livenessTimer) clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => {
        lastError = `no frames for ${CONTROL_DEAD_PEER_MS}ms`;
        socket.terminate();
      }, CONTROL_DEAD_PEER_MS);
      livenessTimer.unref();
    };

    socket.on('open', () => {
      armLiveness();
      pingInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, CONTROL_PING_INTERVAL_MS);
      pingInterval.unref();
      send({
        type: 'hello',
        version: CONTROL_PROTOCOL_VERSION,
        selectors,
        replace: (options.replace ?? false) && !claimed,
        ...(sessionId === undefined ? {} : { sessionId }),
        attached: Array.from(instances)
          .filter(([, attachment]) => attachment.tunnel)
          .map(([instanceId]) => instanceId),
        client,
      });
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      armLiveness();
      let message: ControlServerMessage | undefined;
      try {
        if (isBinary) throw new DestinationTunnelProtocolError('unexpected binary control frame');
        message = decodeControlServerMessage(JSON.parse(toBuffer(data).toString('utf8')));
      } catch (error) {
        lastError = `invalid control message: ${errorMessage(error)}`;
        socket.terminate();
        return;
      }
      if (message) handleMessage(message);
    });
    socket.on('ping', armLiveness);
    socket.on('pong', armLiveness);
    socket.on('unexpected-response', (_request, response) => {
      rejectedStatus = response.statusCode ?? 0;
      socket.terminate();
    });
    socket.on('error', (error: Error) => {
      lastError ??= error.message;
    });
    socket.once('close', (code: number, reason: Buffer) => {
      if (pingInterval) clearInterval(pingInterval);
      if (livenessTimer) clearTimeout(livenessTimer);
      if (ws === socket) ws = undefined;
      if (stopped) return;
      if (rejectedStatus !== undefined) {
        // A refused upgrade with a 4xx status never succeeds on retry.
        if (rejectedStatus >= 400 && rejectedStatus < 500) {
          fail(upgradeRejectionMessage(rejectedStatus, options.organizationId));
        } else {
          scheduleReconnect(`the server answered HTTP ${rejectedStatus}`, false);
        }
        return;
      }
      if (code === 1006 && lastError) {
        scheduleReconnect(lastError, false);
        return;
      }
      handleClose(code, reason.toString());
    });
  };

  const close = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    forgetAll();
    const socket = ws;
    if (socket?.readyState === WebSocket.OPEN) {
      // bye releases the name at once instead of after the lease expires.
      socket.send(JSON.stringify({ type: 'bye' } satisfies ControlClientMessage));
      await new Promise<void>((resolve) => {
        const grace = setTimeout(() => socket.terminate(), BYE_GRACE_MS);
        socket.once('close', () => {
          clearTimeout(grace);
          resolve();
        });
        socket.close(1000, 'bye');
      });
    } else {
      socket?.terminate();
    }
    resolveClosed();
  };

  connectControl();
  return { closed, close };
}

function decodeControlServerMessage(value: unknown): ControlServerMessage | undefined {
  const message = readRecord(value, 'tunnel control message');
  const type = readString(message, 'type');
  switch (type) {
    case 'active': {
      const leaseSeconds = readInteger(message, 'leaseSeconds');
      if (leaseSeconds < 1) {
        throw new DestinationTunnelProtocolError('leaseSeconds must be positive');
      }
      return { type, sessionId: readNonEmptyString(message, 'sessionId'), leaseSeconds };
    }
    case 'standby': {
      const holder = readRecord(message['holder'], 'holder');
      return {
        type,
        holder: { hostname: readString(holder, 'hostname'), ...readOptionalString(holder, 'since') },
      };
    }
    case 'attach':
      return {
        type,
        instanceId: readNonEmptyString(message, 'instanceId'),
        url: readNonEmptyString(message, 'url'),
        token: readNonEmptyString(message, 'token'),
      };
    case 'detach':
      return {
        type,
        instanceId: readNonEmptyString(message, 'instanceId'),
        reason: readString(message, 'reason'),
      };
    case 'notice':
      return {
        type,
        code: readString(message, 'code'),
        message: readString(message, 'message'),
        ...readOptionalString(message, 'instanceId'),
      };
    case 'revoked':
      return { type, reason: readString(message, 'reason') };
    default:
      // Newer servers may add message types that this connector does not need.
      return undefined;
  }
}

function deriveTunnelConnectURL(baseURL: string, organizationId: string, name: string): string {
  const url = new URL(baseURL);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported baseURL protocol: ${url.protocol}`);
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname =
    `${url.pathname.replace(/\/+$/, '')}/v1/organizations/${encodeURIComponent(organizationId)}` +
    `/tunnels/${encodeURIComponent(name)}/connect`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function upgradeRejectionMessage(status: number, organizationId: string): string {
  switch (status) {
    case 401:
      return 'the API key was rejected (HTTP 401)';
    case 403:
      return 'connecting a tunnel needs an admin API key with tunnel access (HTTP 403)';
    case 404:
      return `organization ${organizationId} has no tunnel endpoint (HTTP 404)`;
    default:
      return `the server refused the connection (HTTP ${status})`;
  }
}

function revokedMessage(reason: string): string {
  switch (reason) {
    case 'replaced':
      return 'another connector replaced this one';
    case 'deleted':
      return 'the tunnel was deleted';
    case 'credential':
      return 'the API key was revoked';
    default:
      return `the tunnel was revoked (${reason})`;
  }
}

/** HTTP status of a refused instance tunnel upgrade, as reported by ws. */
function upgradeStatus(error: unknown): number | undefined {
  const match = /^Unexpected server response: (\d+)$/.exec(errorMessage(error));
  return match?.[1] ? Number(match[1]) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jittered(delayMs: number): number {
  return Math.round(delayMs * (0.75 + Math.random() * 0.5));
}
