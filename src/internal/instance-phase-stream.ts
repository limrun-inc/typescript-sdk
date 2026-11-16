import { createEventSource, type EventSourceMessage } from 'eventsource-client';

import { nodeProxyTransport } from './proxy-transport';

/** Credentials for a phase stream: a fixed API key, or headers resolved on every connection. */
export type PhaseStreamAuth =
  | { apiKey: string; getHeaders?: never }
  | {
      apiKey?: never;
      /** Resolves current credentials on every connection, including reconnects. */
      getHeaders: () => Promise<Headers>;
    };

/**
 * How to follow one instance's phase stream: an endpoint that answers JSON, or an event per
 * phase change when asked for `text/event-stream`, and a `gone` event when the instance leaves.
 * Xcode's cache and Gradle's snapshot both serve this shape.
 */
export type PhaseStreamOptions<T> = {
  url: string;
  auth: PhaseStreamAuth;
  instanceId: string;
  /** The event carrying a state; `gone` is handled for every stream. */
  eventName: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onOpen?: (() => void) | undefined;
  onUpdate?: ((state: T) => void) | undefined;
  /** Identifies a state, so a reconnect that replays the current one is not reported again. */
  transitionKey: (state: T) => string;
  isTerminal: (state: T) => boolean;
  goneError: () => Error;
  timeoutError: (last: T | undefined) => Error;
  unreadableError: (err: unknown) => Error;
};

export type PhaseStreamResult<T> = {
  /** The last state seen, terminal unless the stream ended first. */
  state: T;
  /** True when the instance was collected before the phase went terminal. */
  gone: boolean;
};

/**
 * Follows an instance's phase stream until a state is terminal, the instance is collected, or the
 * wait times out. The server emits on phase change only, so every callback is a real transition.
 */
export function followPhaseStream<T>(options: PhaseStreamOptions<T>): Promise<PhaseStreamResult<T>> {
  const { url, auth } = options;
  const fetchAuthenticated: typeof nodeProxyTransport.fetch = async (input, init) => {
    const headers = new Headers(
      auth.getHeaders ? await auth.getHeaders() : { Authorization: `Bearer ${auth.apiKey}` },
    );
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    return nodeProxyTransport.fetch(input, { ...init, headers });
  };
  return new Promise<PhaseStreamResult<T>>((resolve, reject) => {
    let last: T | undefined;
    let lastKey = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        source.close();
      } catch {
        // A stream that never opened has nothing to close.
      }
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(options.timeoutError(last))), options.timeoutMs);
    const onAbort = () => finish(() => reject(options.signal?.reason ?? new Error('aborted')));
    const resolveGone = () =>
      finish(() => (last !== undefined ? resolve({ state: last, gone: true }) : reject(options.goneError())));

    let confirming = false;
    const confirmGone = () => {
      if (confirming || settled) return;
      confirming = true;
      fetchAuthenticated(url, {
        headers: { Accept: 'application/json' },
      })
        .then(async (res) => {
          confirming = false;
          if (res.status !== 404) {
            await res.text().catch(() => undefined);
            return;
          }
          resolveGone();
        })
        .catch(() => {
          confirming = false;
        });
    };

    // The endpoint answers from the region, which keeps the instance while it terminates and
    // drops it once it is collected, so a 404 is the instance being over rather than a fault.
    // Without this the client treats it as a connection to retry and follows a gone instance
    // until the timeout, which is minutes of a command that looks hung and says nothing.
    const fetchOrGone: typeof nodeProxyTransport.fetch = async (input, init) => {
      const res = await fetchAuthenticated(input, init);
      if (res.status === 404) resolveGone();
      return res;
    };

    const source = createEventSource({
      url,
      fetch: fetchOrGone,
      onConnect: () => options.onOpen?.(),
      headers: {
        Accept: 'text/event-stream',
      },
      onMessage: (message: EventSourceMessage) => {
        if (message.event !== options.eventName && message.event !== 'gone') return;
        let state: T;
        try {
          state = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
        } catch (err) {
          finish(() => reject(options.unreadableError(err)));
          return;
        }
        last = state;
        if (message.event === 'gone') {
          // The server also ends the stream this way when its own watch is cut short, which
          // Kubernetes does routinely on a long one, so a request decides which it was. The
          // client library reconnects on its own when the instance is in fact still there.
          confirmGone();
          return;
        }
        // A reconnect replays the current state, which is not a transition.
        const key = options.transitionKey(state);
        if (key !== lastKey) {
          lastKey = key;
          options.onUpdate?.(state);
        }
        if (options.isTerminal(state)) {
          finish(() => resolve({ state, gone: false }));
        }
      },
    });

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
