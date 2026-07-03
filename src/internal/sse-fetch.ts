import type { Fetch } from './builtin-types';

/**
 * Wraps a fetch for use with eventsource-client, which swallows a REJECTED
 * fetch (connection refused, instance gone) into a silent reconnect loop
 * without ever calling onDisconnect. The wrapper reports the rejection so the
 * caller can settle its promise instead of hanging while the client
 * reconnect-loops. exec-client has the same latent hazard and should adopt
 * this when touched next.
 */
export function sseFetch(fetchImpl: Fetch, onRejected: (err: unknown) => void): Fetch {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (err) {
      onRejected(err);
      throw err;
    }
  };
}
