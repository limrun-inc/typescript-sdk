import {
  isTerminalDestinationTunnelError,
  startDestinationTcpTunnel,
  type DestinationTcpTunnel,
  type DestinationTcpTunnelOptions,
} from './destination-tunnel-dialer';
import type { TunnelConnectionState, TunnelConnectionStateCallback } from './tunnel';

export interface DestinationTunnelSupervisorOptions extends DestinationTcpTunnelOptions {
  /** First reconnect delay. Defaults to 500ms. */
  initialBackoffMs?: number;
  /** Reconnect delay ceiling. Defaults to 30s. */
  maxBackoffMs?: number;
  /**
   * Consulted before every reconnect attempt. Return false to stop the
   * supervisor, e.g. when a detached owner has been cancelled. The first
   * connection attempt is not gated.
   */
  shouldReconnect?: () => boolean | Promise<boolean>;
  /**
   * Called with each new tunnel generation, including the first. Reconnected
   * generations have new tunnel IDs; flows never resume across generations.
   */
  onGeneration?: (tunnel: DestinationTcpTunnel) => void;
  /** Called after each failed reconnect attempt with the upcoming delay. */
  onRetry?: (error: Error, nextDelayMs: number) => void;
}

export interface SupervisedDestinationTunnel {
  /** Tunnel ID of the current generation. */
  tunnelId: string;
  /** The live tunnel generation, absent while reconnecting. */
  getCurrentTunnel: () => DestinationTcpTunnel | undefined;
  getConnectionState: () => TunnelConnectionState;
  onConnectionStateChange: (callback: TunnelConnectionStateCallback) => () => void;
  close: () => void;
  /** Resolves when the supervisor stops: closed, cancelled, or terminal error. */
  closed: Promise<void>;
}

/**
 * Run a destination tunnel under a reconnect supervisor. The first connection
 * failure rejects; after the first READY, transport failures reconnect with
 * jittered exponential backoff replaying the same immutable selectors.
 * Terminal server rejections (protocol `error` controls) stop the supervisor.
 */
export async function superviseDestinationTcpTunnel(
  remoteURL: string,
  token: string,
  options: DestinationTunnelSupervisorOptions,
): Promise<SupervisedDestinationTunnel> {
  const {
    initialBackoffMs = 500,
    maxBackoffMs = 30_000,
    shouldReconnect,
    onGeneration,
    onRetry,
    ...tunnelOptions
  } = options;

  let currentTunnel: DestinationTcpTunnel | undefined;
  let closedByUser = false;
  let connectionState: TunnelConnectionState = 'connecting';
  const stateCallbacks = new Set<TunnelConnectionStateCallback>();
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const updateState = (state: TunnelConnectionState): void => {
    if (connectionState === state) return;
    connectionState = state;
    for (const callback of stateCallbacks) {
      try {
        callback(state);
      } catch {
        // State observers must not break supervision.
      }
    }
  };

  const first = await startDestinationTcpTunnel(remoteURL, token, tunnelOptions);
  currentTunnel = first;
  updateState('connected');
  onGeneration?.(first);

  const superviseFrom = (tunnel: DestinationTcpTunnel): void => {
    const unsubscribe = tunnel.onConnectionStateChange((state) => {
      if (state !== 'disconnected') return;
      unsubscribe();
      if (closedByUser) {
        updateState('disconnected');
        resolveClosed();
        return;
      }
      currentTunnel = undefined;
      updateState('connecting');
      void reconnectLoop();
    });
    if (tunnel.getConnectionState() === 'disconnected') {
      unsubscribe();
      if (closedByUser) {
        updateState('disconnected');
        resolveClosed();
        return;
      }
      currentTunnel = undefined;
      updateState('connecting');
      void reconnectLoop();
    }
  };

  const reconnectLoop = async (): Promise<void> => {
    let delayMs = initialBackoffMs;
    for (;;) {
      if (closedByUser) {
        updateState('disconnected');
        resolveClosed();
        return;
      }
      if (shouldReconnect && !(await shouldReconnect())) {
        updateState('disconnected');
        resolveClosed();
        return;
      }
      try {
        const tunnel = await startDestinationTcpTunnel(remoteURL, token, tunnelOptions);
        if (closedByUser) {
          tunnel.close();
          updateState('disconnected');
          resolveClosed();
          return;
        }
        currentTunnel = tunnel;
        handle.tunnelId = tunnel.tunnelId;
        updateState('connected');
        onGeneration?.(tunnel);
        superviseFrom(tunnel);
        return;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (isTerminalDestinationTunnelError(failure)) {
          updateState('disconnected');
          resolveClosed();
          return;
        }
        const jitter = 0.75 + Math.random() * 0.5;
        const sleepMs = Math.min(Math.round(delayMs * jitter), maxBackoffMs);
        onRetry?.(failure, sleepMs);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        delayMs = Math.min(delayMs * 2, maxBackoffMs);
      }
    }
  };

  const handle: SupervisedDestinationTunnel = {
    tunnelId: first.tunnelId,
    getCurrentTunnel: () => currentTunnel,
    getConnectionState: () => connectionState,
    onConnectionStateChange: (callback) => {
      stateCallbacks.add(callback);
      return () => stateCallbacks.delete(callback);
    },
    close: () => {
      if (closedByUser) return;
      closedByUser = true;
      const tunnel = currentTunnel;
      currentTunnel = undefined;
      if (tunnel) {
        tunnel.close();
      } else {
        updateState('disconnected');
        resolveClosed();
      }
    },
    closed: closedPromise,
  };

  superviseFrom(first);
  return handle;
}
