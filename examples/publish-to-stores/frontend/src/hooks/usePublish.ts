// The Publish phase: posts to the backend's /publish endpoint, then polls
// the publish status until the build-finish webhook settles it. There is
// no live log — the outcome is the webhook payload, which the UI renders
// along with how long the build took.
import { useState } from 'react';
import {
  errorMessage,
  fetchPublishStatus,
  sleep,
  startPublish,
  type PublishInput,
  type PublishStatus,
} from '../lib/backend';

export type PublishState = 'idle' | 'running' | 'succeeded' | 'failed';

const POLL_INTERVAL_MS = 3000;

export type PublishController = ReturnType<typeof usePublish>;

export function usePublish() {
  const [state, setState] = useState<PublishState>('idle');
  const [status, setStatus] = useState<PublishStatus>();
  const [error, setError] = useState<string>();

  // Polling happens right here in the action instead of in an effect: the
  // publish button stays disabled while state is 'running', and the app
  // keeps this hook mounted for the whole session, so a plain loop is all
  // the lifecycle management the flow needs.
  async function publish(input: PublishInput) {
    setState('running');
    setStatus(undefined);
    setError(undefined);
    try {
      const publishId = await startPublish(input);
      while (true) {
        await sleep(POLL_INTERVAL_MS);
        // Transient poll failures are retried silently on the next tick;
        // only the publish status itself is truth.
        const fetched = await fetchPublishStatus(publishId).catch(() => undefined);
        if (!fetched) continue;
        setStatus(fetched);
        if (fetched.state !== 'running') {
          setState(fetched.state);
          if (fetched.error) setError(fetched.error);
          return;
        }
      }
    } catch (caught) {
      setError(errorMessage(caught, 'Publish failed'));
      setState('failed');
    }
  }

  return { state, status, error, publish };
}
