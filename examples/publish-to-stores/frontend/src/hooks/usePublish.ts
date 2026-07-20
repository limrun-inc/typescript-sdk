// The Publish phase: picks a method, posts to the backend's /publish
// endpoint, and accumulates the streamed build log until the CLI exits.
import { useCallback, useState } from 'react';
import { errorMessage } from '../lib/apple';
import { streamPublish, type PublishInput, type PublishMethod } from '../lib/backend';

export type PublishLogLine = {
  stream: 'stdout' | 'stderr' | 'error';
  text: string;
};

export type PublishState = 'idle' | 'running' | 'succeeded' | 'failed';

export type PublishController = ReturnType<typeof usePublish>;

export function usePublish() {
  const [method, setMethod] = useState<PublishMethod>('testflight');
  const [state, setState] = useState<PublishState>('idle');
  const [lines, setLines] = useState<PublishLogLine[]>([]);
  const [exitCode, setExitCode] = useState<number>();

  const publish = useCallback(async (input: Omit<PublishInput, 'method'> & { method?: PublishMethod }) => {
    setState('running');
    setLines([]);
    setExitCode(undefined);
    const chosen = input.method ?? 'testflight';
    setMethod(chosen);
    try {
      let finalExit: number | undefined;
      await streamPublish({ ...input, method: chosen }, ({ event, data }) => {
        if (event === 'exit') {
          finalExit = Number(data);
          return;
        }
        if (event === 'stdout' || event === 'stderr' || event === 'error') {
          setLines((current) => [...current, { stream: event, text: data }]);
        }
      });
      setExitCode(finalExit);
      setState(finalExit === 0 ? 'succeeded' : 'failed');
    } catch (error) {
      setLines((current) => [
        ...current,
        { stream: 'error', text: errorMessage(error, 'Publish failed') },
      ]);
      setState('failed');
    }
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    setLines([]);
    setExitCode(undefined);
  }, []);

  return { method, setMethod, state, lines, exitCode, publish, reset };
}
