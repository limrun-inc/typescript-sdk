// The Publish phase: picks a method, posts to the backend's /publish
// endpoint, then polls the publish status until the build-finish webhook
// settles it. There is no live log — the outcome is the webhook payload,
// which the UI renders along with how long the build took.
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../lib/apple';
import {
  fetchPublishStatus,
  startPublish,
  type PublishInput,
  type PublishMethod,
  type PublishStatus,
} from '../lib/backend';

export type PublishState = 'idle' | 'running' | 'succeeded' | 'failed';

const POLL_INTERVAL_MS = 3000;

export type PublishController = ReturnType<typeof usePublish>;

export function usePublish() {
  const [method, setMethod] = useState<PublishMethod>('testflight');
  const [state, setState] = useState<PublishState>('idle');
  const [publishId, setPublishId] = useState<string>();
  const [status, setStatus] = useState<PublishStatus>();
  const [error, setError] = useState<string>();

  const publish = useCallback(async (input: Omit<PublishInput, 'method'> & { method?: PublishMethod }) => {
    setState('running');
    setPublishId(undefined);
    setStatus(undefined);
    setError(undefined);
    const chosen = input.method ?? 'testflight';
    setMethod(chosen);
    try {
      setPublishId(await startPublish({ ...input, method: chosen }));
    } catch (caught) {
      setError(errorMessage(caught, 'Publish failed'));
      setState('failed');
    }
  }, []);

  // Poll while a publish is in flight. Transient poll failures are retried
  // silently on the next tick; only the publish status itself is truth.
  useEffect(() => {
    if (state !== 'running' || !publishId) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchPublishStatus(publishId)
        .then((fetched) => {
          if (cancelled) return;
          setStatus(fetched);
          if (fetched.state !== 'running') {
            setState(fetched.state);
            if (fetched.error) setError(fetched.error);
          }
        })
        .catch(() => {
          // Backend momentarily unreachable; keep polling.
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state, publishId]);

  const reset = useCallback(() => {
    setState('idle');
    setPublishId(undefined);
    setStatus(undefined);
    setError(undefined);
  }, []);

  return { method, setMethod, state, status, error, publish, reset };
}
