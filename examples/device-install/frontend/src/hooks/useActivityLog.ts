import { useCallback, useState } from 'react';
import type { LogEntry } from '../types';

export type ActivityLog = {
  entries: LogEntry[];
  /** Append a line to the bottom of the log. Pass `push` as the `log` callback
   * to the Limrun hooks so their progress messages show up in the UI too. */
  push: (message: string, detail?: unknown) => void;
};

export function useActivityLog(): ActivityLog {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const push = useCallback((message: string, detail?: unknown) => {
    setEntries((current) => [
      ...current,
      { at: new Date().toLocaleTimeString(), message, detail: detail ? String(detail) : undefined },
    ]);
  }, []);

  return { entries, push };
}
