import { useEffect, useRef } from 'react';
import type { PlaybackStats } from './playback-stats';
import { subscribePlaybackStats, type PlaybackConnection } from './playback-subscription';
export type { PlaybackConnection } from './playback-subscription';

export function usePlaybackStats(
  connection: PlaybackConnection | null,
  callback: ((stats: PlaybackStats | null) => void) | undefined,
  target: number | null | undefined,
): void {
  const callbackRef = useRef(callback);
  const targetRef = useRef(target);
  callbackRef.current = callback;
  targetRef.current = target;
  const enabled = !!callback;
  useEffect(() => {
    if (!connection || !enabled) return;
    return subscribePlaybackStats(
      connection,
      () => callbackRef.current,
      () => targetRef.current,
    );
  }, [connection, enabled]);
}
