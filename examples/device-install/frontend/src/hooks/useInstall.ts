import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../lib/apple';
import {
  fetchInstallStatus,
  startInstall,
  type InstallInput,
  type InstallMethod,
  type InstallStatus,
} from '../lib/backend';

export type InstallBuildState = 'idle' | 'running' | 'succeeded' | 'failed';
export type InstallController = ReturnType<typeof useInstall>;
const POLL_INTERVAL_MS = 3000;

export function useInstall() {
  const [method, setMethod] = useState<InstallMethod>('webusb');
  const [state, setState] = useState<InstallBuildState>('idle');
  const [installId, setInstallId] = useState<string>();
  const [status, setStatus] = useState<InstallStatus>();
  const [error, setError] = useState<string>();

  const selectMethod = useCallback((selected: InstallMethod) => {
    setMethod(selected);
    setState('idle');
    setInstallId(undefined);
    setStatus(undefined);
    setError(undefined);
  }, []);

  const build = useCallback(async (input: InstallInput) => {
    setMethod(input.method);
    setState('running');
    setInstallId(undefined);
    setStatus(undefined);
    setError(undefined);
    try {
      setInstallId(await startInstall(input));
    } catch (caught) {
      setError(errorMessage(caught, 'Install build failed'));
      setState('failed');
    }
  }, []);

  useEffect(() => {
    if (state !== 'running' || !installId) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchInstallStatus(installId)
        .then((fetched) => {
          if (cancelled) return;
          setStatus(fetched);
          if (fetched.state !== 'running') {
            setState(fetched.state);
            if (fetched.error) setError(fetched.error);
          }
        })
        .catch(() => {
          // Retry transient status failures on the next poll.
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [installId, state]);

  return { method, setMethod: selectMethod, state, status, error, build };
}
