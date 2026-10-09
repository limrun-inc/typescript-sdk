import os from 'os';
import { WebSocket, type RawData } from 'ws';
import { nodeProxyTransport } from './internal/proxy-transport';
import { deriveDestinationTunnelURL, deriveTunnelConnectURL } from './internal/destination-tunnel-url';
import {
  getDestinationTunnelStatus,
  stopDestinationTunnel,
  type DestinationTunnelStatus,
} from './internal/destination-tunnel-management';
import {
  DestinationTunnelProtocolError,
  readPositiveInteger,
  readStringArray,
  readNonEmptyString,
  readOptionalString,
  readRecord,
  readString,
  toBuffer,
} from './internal/destination-tunnel-wire-reader';
import {
  DestinationTunnelSessionError,
  destinationTunnelDialOptions,
  destinationTunnelInspection,
  startDestinationTcpTunnel,
  type DestinationTcpTunnel,
} from './destination-tunnel-dialer';
import {
  normalizeDestinationTunnelInspection,
  validateDestinationTunnelSelectors,
  type DestinationTunnelInspectionConfig,
  type DestinationTunnelSelectors,
} from './destination-tunnel';
import { upgradeStatus, type LogLevel } from './tunnel';
import { VERSION } from './version';

const CONTROL_PROTOCOL_VERSION = 2;
const CONTROL_HANDSHAKE_TIMEOUT_MS = 15_000;
const CONTROL_PING_INTERVAL_MS = 15_000;
const CONTROL_DEAD_PEER_MS = 45_000;
const CONTROL_INITIAL_BACKOFF_MS = 500;
const CONTROL_MAX_BACKOFF_MS = 10_000;
const BYE_GRACE_MS = 1_000;
const ATTACH_INITIAL_BACKOFF_MS = 1_000;
const ATTACH_MAX_BACKOFF_MS = 30_000;
/** The platform deletes an instance whose tunnel has not attached 30s after assignment. */
const ATTACH_FIRST_MAX_BACKOFF_MS = 2_000;
/** The API explains a refused connection in a short plain-text body. */
const MAX_REJECTION_REASON_CHARS = 200;
/** Every tunnel WebSocket counts as instance activity, so retries must end. */
const ATTACH_GIVE_UP_MS = 5 * 60_000;
const TAKEN_OVER_MESSAGE = 'another connector for this tunnel took the instance over';
/** A token this close to its expiry is not dialed with; the hub refreshes it at half its life. */
const TOKEN_EXPIRY_MARGIN_MS = 5_000;
/** How long before its token expires the connector starts warning, and how often. */
const KEY_WARNING_WINDOW_MS = 14 * 24 * 60 * 60_000;
const KEY_WARNING_EVERY_MS = 24 * 60 * 60_000;

export interface TunnelConnectorOptions {
  /** The tunnel's token; no other credential connects. */
  apiKey: string;
  /** Limrun API base URL, such as https://api.limrun.com. */
  baseURL: string;
  organizationId: string;
  /**
   * The ID of a tunnel created in the console or the API. Its name, which
   * instances set in `spec.tunnel`, and its selectors come from the platform.
   */
  tunnelId: string;
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
  /** This connector holds the tunnel; emitted once per session and control connection. */
  | { type: 'active'; sessionId: string; name: string }
  /** The connector's tunnel token expires within two weeks; emitted once a day until it does. */
  | { type: 'keyExpiring'; expiresAt: string }
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
      replace: boolean;
      sessionId?: string;
      attached: string[];
      client: { hostname: string; version: string };
    }
  | { type: 'attached'; instanceId: string; tunnelId: string }
  | { type: 'attachFailed'; instanceId: string; code: string; message: string; terminal: boolean }
  | { type: 'bye' };

type ControlServerMessage =
  | { type: 'active'; sessionId: string; leaseSeconds: number; name: string; keyExpiresAt?: string }
  | { type: 'standby'; holder: { hostname: string; since?: string } }
  | {
      type: 'attach';
      instanceId: string;
      url: string;
      selectors: string[];
      token: string;
      expiresInSeconds: number;
    }
  | { type: 'token'; instanceId: string; token: string; expiresInSeconds: number }
  | { type: 'detach'; instanceId: string; reason: string }
  | { type: 'notice'; code: string; message: string; instanceId?: string }
  | { type: 'revoked'; reason: string };

interface InstanceAttachment {
  /** Instance base URL: the iOS API URL or the Android ADB WebSocket URL. */
  url: string;
  /** Opens this instance's tunnel and nothing else; the hub keeps it fresh. */
  token: string;
  tokenExpiresAt: number;
  /** The tunnel's selectors when the instance first attached; later edits apply to later instances. */
  selectors: DestinationTunnelSelectors;
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
 * Serve a persistent tunnel: hold it through one control WebSocket to the
 * Limrun API and open a destination tunnel to every instance created with
 * `spec.tunnel` set to its name, with a short-lived token the API hands out
 * for each. Instance tunnels stay up while the control channel reconnects,
 * so an API outage never becomes a tunnel outage; one that drops re-dials
 * once the API sends a fresh token.
 */
export function runTunnel(options: TunnelConnectorOptions): TunnelConnector {
  // Reject a bad inspection config now rather than on every attach.
  normalizeDestinationTunnelInspection(destinationTunnelInspection(options.inspection));
  const controlURL = deriveTunnelConnectURL(options.baseURL, options.organizationId, options.tunnelId);
  const client = {
    hostname: options.hostname ?? os.hostname(),
    version: options.clientVersion ?? VERSION,
  };

  const instances = new Map<string, InstanceAttachment>();
  let ws: WebSocket | undefined;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let controlBackoffMs = CONTROL_INITIAL_BACKOFF_MS;
  let sessionId: string | undefined;
  // --replace takes the name over once; afterwards this connector resumes
  // like any holder and never steals the name back.
  let replace = options.replace ?? false;
  // When the last confirmed lease runs out; zero while on standby.
  let leaseExpiresAt = 0;
  // The tunnel's name, from the first active; instances set it in spec.tunnel.
  let tunnelName: string | undefined;
  let lastKeyWarning = 0;
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

  const isConfirmedHolder = (): boolean => Date.now() < leaseExpiresAt;

  const forget = (instanceId: string, attachment: InstanceAttachment): void => {
    const tunnel = attachment.tunnel;
    attachment.tunnel = undefined;
    attachment.done = true;
    clearTimeout(attachment.retryTimer);
    tunnel?.close();
    if (instances.get(instanceId) === attachment) instances.delete(instanceId);
  };

  // Ends the connector once: no more reconnects, and every instance tunnel closes.
  const shutdown = (): boolean => {
    if (stopped) return false;
    stopped = true;
    clearTimeout(reconnectTimer);
    for (const [instanceId, attachment] of instances) forget(instanceId, attachment);
    return true;
  };

  const fail = (detail: string): void => {
    if (!shutdown()) return;
    ws?.terminate();
    rejectClosed(new Error(`tunnel ${tunnelName ?? options.tunnelId}: ${detail}`));
  };

  const dialOptions = (attachment: InstanceAttachment) => ({
    ...destinationTunnelDialOptions(
      { selectors: attachment.selectors, ...(options.inspection ? { inspection: options.inspection } : {}) },
      options.logLevel ?? 'warn',
    ),
    ...(tunnelName === undefined ? {} : { name: tunnelName }),
  });

  const tokenUsable = (attachment: InstanceAttachment): boolean =>
    Date.now() < attachment.tokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS;

  // Tells the platform and the caller that the connector gave up on an instance.
  const reportGivenUp = (instanceId: string, code: string, message: string): void => {
    send({ type: 'attachFailed', instanceId, code, message, terminal: true });
    emit({ type: 'attachFailed', instanceId, code, message });
  };

  const giveUp = (
    instanceId: string,
    attachment: InstanceAttachment,
    code: string,
    message: string,
  ): void => {
    forget(instanceId, attachment);
    reportGivenUp(instanceId, code, message);
  };

  const scheduleAttachRetry = (instanceId: string, attachment: InstanceAttachment, reason: string): void => {
    const delayMs = jittered(attachment.backoffMs);
    const maxMs = attachment.lastTunnelId === undefined ? ATTACH_FIRST_MAX_BACKOFF_MS : ATTACH_MAX_BACKOFF_MS;
    attachment.backoffMs = Math.min(attachment.backoffMs * 2, maxMs);
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
  // superseding each other forever. A stopping tunnel is on its way out.
  const takenOver = async (attachment: InstanceAttachment): Promise<boolean> => {
    try {
      const active = (await getDestinationTunnelStatus(attachment.url, attachment.token)).active;
      return (
        active !== undefined &&
        active.name === tunnelName &&
        active.state !== 'stopping' &&
        active.tunnelId !== attachment.lastTunnelId
      );
    } catch {
      // The dial that follows surfaces a real failure.
      return false;
    }
  };

  // A failed stop shows up as the same tunnel on the next attempt.
  const stopQuietly = async (attachment: InstanceAttachment, tunnelId: string): Promise<void> => {
    try {
      await stopDestinationTunnel(attachment.url, attachment.token, tunnelId);
    } catch {
      // The next attempt reports a tunnel that is still there.
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
    // A stopping tunnel, such as one this connector just stopped, refuses
    // new claims until it is gone; wait it out instead of yielding.
    if (!active || active.state === 'stopping') {
      retryAfterFailure(instanceId, attachment, 'already_active', 'the previous tunnel is still stopping');
      return;
    }
    if (active.name !== tunnelName) {
      giveUp(instanceId, attachment, 'instance_busy', 'the instance already has another tunnel');
      return;
    }
    // This connector's own dropped tunnel lingers until the instance notices
    // the dead socket; stop it instead of waiting. The backoff keeps a failing
    // stop from spinning.
    if (active.tunnelId === attachment.lastTunnelId) {
      await stopQuietly(attachment, active.tunnelId);
      if (!attachment.done) {
        retryAfterFailure(instanceId, attachment, 'already_active', 'stopping the dropped tunnel');
      }
      return;
    }
    // Only the confirmed holder may stop another same-name tunnel, and only
    // once: it can then belong to nobody but a dead predecessor.
    if (attachment.mayReclaim && isConfirmedHolder()) {
      attachment.mayReclaim = false;
      await stopQuietly(attachment, active.tunnelId);
      if (!attachment.done) void attach(instanceId, attachment);
      return;
    }
    giveUp(instanceId, attachment, 'taken_over', TAKEN_OVER_MESSAGE);
  };

  const attach = async (instanceId: string, attachment: InstanceAttachment): Promise<void> => {
    attachment.retryTimer = undefined;
    // Only the confirmed holder dials, so a connector that lost the name
    // never pushes the holder's tunnel off. The instance waits until a
    // renewal confirms the lease again or the attach deadline passes.
    if (!isConfirmedHolder()) {
      retryAfterFailure(instanceId, attachment, 'not_holder', 'this connector does not hold the tunnel');
      return;
    }
    // A token past its life is refused; the API sends a fresh one at half
    // life, so this only waits while the control channel is down.
    if (!tokenUsable(attachment)) {
      retryAfterFailure(instanceId, attachment, 'token_expired', 'waiting for a fresh attach token');
      return;
    }
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
        dialOptions(attachment),
      );
    } catch (error) {
      if (attachment.done) return;
      if (upgradeStatus(errorMessage(error)) === 404) {
        giveUp(instanceId, attachment, 'instance_gone', 'the instance is gone or terminating');
      } else if (!(error instanceof DestinationTunnelSessionError)) {
        retryAfterFailure(instanceId, attachment, 'connect_failed', errorMessage(error));
      } else if (error.code === 'already_active') {
        await resolveAlreadyActive(instanceId, attachment);
      } else if (error.code === 'unavailable' || error.code === 'internal') {
        // The instance cannot start a tunnel right now, such as while its
        // inspection helper restarts.
        retryAfterFailure(
          instanceId,
          attachment,
          error.code,
          `the instance could not start the tunnel: ${error.code}`,
        );
      } else {
        giveUp(instanceId, attachment, error.code, `the instance rejected the tunnel: ${error.code}`);
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
    const dropped = (): void => {
      attachment.tunnel = undefined;
      attachment.failingSince = Date.now();
      scheduleAttachRetry(instanceId, attachment, 'the instance tunnel disconnected');
    };
    tunnel.onConnectionStateChange((state) => {
      if (state === 'disconnected' && attachment.tunnel === tunnel) dropped();
    });
    // A drop between the dial resolving and the listener above fires no event.
    if (tunnel.getConnectionState() === 'disconnected') {
      dropped();
      return;
    }
    send({ type: 'attached', instanceId, tunnelId: tunnel.tunnelId });
    emit({ type: 'attached', instanceId, tunnelId: tunnel.tunnelId });
  };

  const handleMessage = (message: ControlServerMessage): void => {
    // close() already let every instance go; a late attach must not dial.
    if (stopped) return;
    switch (message.type) {
      case 'active': {
        replace = false;
        leaseExpiresAt = Date.now() + message.leaseSeconds * 1000;
        controlBackoffMs = CONTROL_INITIAL_BACKOFF_MS;
        sessionId = message.sessionId;
        tunnelName = message.name;
        announcedHolder = undefined;
        if (announcedSession !== message.sessionId) {
          announcedSession = message.sessionId;
          emit({ type: 'active', sessionId: message.sessionId, name: message.name });
        }
        const now = Date.now();
        if (
          message.keyExpiresAt !== undefined &&
          Date.parse(message.keyExpiresAt) - now < KEY_WARNING_WINDOW_MS &&
          now - lastKeyWarning >= KEY_WARNING_EVERY_MS
        ) {
          lastKeyWarning = now;
          emit({ type: 'keyExpiring', expiresAt: message.keyExpiresAt });
        }
        return;
      }
      case 'standby': {
        leaseExpiresAt = 0;
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
      case 'token': {
        // A fresh token at half its life, or after a resume. An instance this
        // connector gave up on stays given up.
        const attachment = instances.get(message.instanceId);
        if (attachment) {
          attachment.token = message.token;
          attachment.tokenExpiresAt = Date.now() + message.expiresInSeconds * 1000;
        }
        return;
      }
      case 'attach': {
        // Expiry is relative, so this host's clock never matters.
        const tokenExpiresAt = Date.now() + message.expiresInSeconds * 1000;
        const existing = instances.get(message.instanceId);
        if (existing) {
          // A new holder session re-attaches every instance, including ones
          // this connector still serves; a live tunnel only needs confirming.
          // The instance keeps the selectors it first got.
          existing.url = message.url;
          existing.token = message.token;
          existing.tokenExpiresAt = tokenExpiresAt;
          if (existing.tunnel) {
            send({ type: 'attached', instanceId: message.instanceId, tunnelId: existing.tunnel.tunnelId });
          }
          return;
        }
        // The instance itself refuses what its platform cannot route, such
        // as Android routes below port 1024.
        let selectors: DestinationTunnelSelectors;
        try {
          selectors = validateDestinationTunnelSelectors(message.selectors);
        } catch (error) {
          reportGivenUp(message.instanceId, 'invalid_selectors', errorMessage(error));
          return;
        }
        const attachment: InstanceAttachment = {
          url: message.url,
          token: message.token,
          tokenExpiresAt,
          selectors,
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
      // A stalled upgrade, such as after a laptop wakes, would otherwise
      // never reconnect.
      handshakeTimeout: CONTROL_HANDSHAKE_TIMEOUT_MS,
    });
    ws = socket;
    announcedSession = undefined;
    let pingInterval: NodeJS.Timeout | undefined;
    let livenessTimer: NodeJS.Timeout | undefined;
    let rejectedStatus: number | undefined;
    let rejectedReason = '';
    let lastError: string | undefined;

    const armLiveness = (): void => {
      clearTimeout(livenessTimer);
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
        replace,
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
      // Anything but the API's plain-text reason, such as a proxy's HTML
      // error page, is left out.
      if (!String(response.headers['content-type'] ?? '').startsWith('text/plain')) {
        socket.terminate();
        return;
      }
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        rejectedReason = (rejectedReason + chunk).slice(0, MAX_REJECTION_REASON_CHARS);
      });
      response.once('end', () => socket.terminate());
      response.once('error', () => socket.terminate());
    });
    socket.on('error', (error: Error) => {
      lastError ??= error.message;
    });
    socket.once('close', (code: number, reason: Buffer) => {
      clearInterval(pingInterval);
      clearTimeout(livenessTimer);
      if (ws === socket) ws = undefined;
      if (stopped) return;
      if (rejectedStatus !== undefined) {
        const reason = rejectedReason.trim();
        const detail = reason ? `HTTP ${rejectedStatus}: ${reason}` : `HTTP ${rejectedStatus}`;
        // A refused upgrade with a 4xx status never succeeds on retry, except
        // a rate limit.
        if (rejectedStatus >= 400 && rejectedStatus < 500 && rejectedStatus !== 429) {
          fail(`the server refused the connection (${detail})`);
        } else {
          scheduleReconnect(`the server answered ${detail}`, false);
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
    if (!shutdown()) return;
    const socket = ws;
    if (socket?.readyState === WebSocket.OPEN) {
      // bye releases the name at once instead of after the lease expires.
      send({ type: 'bye' });
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
      return {
        type,
        sessionId: readNonEmptyString(message, 'sessionId'),
        leaseSeconds: readPositiveInteger(message, 'leaseSeconds'),
        name: readNonEmptyString(message, 'name'),
        ...readOptionalString(message, 'keyExpiresAt'),
      };
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
        selectors: readStringArray(message, 'selectors'),
        token: readNonEmptyString(message, 'token'),
        expiresInSeconds: readPositiveInteger(message, 'expiresInSeconds'),
      };
    case 'token':
      return {
        type,
        instanceId: readNonEmptyString(message, 'instanceId'),
        token: readNonEmptyString(message, 'token'),
        expiresInSeconds: readPositiveInteger(message, 'expiresInSeconds'),
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

function revokedMessage(reason: string): string {
  switch (reason) {
    case 'replaced':
      return 'another connector replaced this one';
    case 'deleted':
      return 'the tunnel was deleted';
    case 'credential':
      return 'its tunnel token was rotated, revoked or has expired';
    default:
      return `the tunnel was revoked (${reason})`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jittered(delayMs: number): number {
  return Math.round(delayMs * (0.75 + Math.random() * 0.5));
}
