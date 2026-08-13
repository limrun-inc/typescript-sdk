import { useRef, useState } from 'react';
import {
  errorMessage,
  fetchInstallStatus,
  sleep,
  startInstall,
  type InstallInput,
  type InstallStatus,
} from '../lib/backend';

export type InstallBuildState = 'idle' | 'running' | 'succeeded' | 'failed';
export type InstallController = ReturnType<typeof useInstall>;
const POLL_INTERVAL_MS = 3000;

export function useInstall() {
  const [state, setState] = useState<InstallBuildState>('idle');
  const [status, setStatus] = useState<InstallStatus>();
  const [error, setError] = useState<string>();

  // Polling runs inside build() rather than in an effect. Starting a new
  // build bumps this sequence so an abandoned build's loop stops writing
  // state; the build itself keeps running server-side.
  const buildSeq = useRef(0);

  async function build(input: InstallInput) {
    const seq = ++buildSeq.current;
    setState('running');
    setStatus(undefined);
    setError(undefined);
    try {
      const installId = await startInstall(input);
      while (true) {
        await sleep(POLL_INTERVAL_MS);
        // Transient status failures are retried on the next tick.
        const fetched = await fetchInstallStatus(installId).catch(() => undefined);
        if (seq !== buildSeq.current) return;
        if (!fetched) continue;
        setStatus(fetched);
        if (fetched.state !== 'running') {
          setState(fetched.state);
          if (fetched.error) setError(fetched.error);
          return;
        }
      }
    } catch (caught) {
      if (seq !== buildSeq.current) return;
      setError(errorMessage(caught, 'Install build failed'));
      setState('failed');
    }
  }

  return { state, status, error, build };
}
