import { PlaybackStatsReader, type PlaybackStats, type PlaybackVideoStats } from './playback-stats';
export interface PlaybackConnection {
  peer: RTCPeerConnection;
  displays: Map<RTCRtpReceiver, PlaybackVideoStats['display']>;
}
const inFlight = new WeakSet<RTCPeerConnection>();

/** Poll only visible, connected subscribers and discard stale asynchronous results. */
export function subscribePlaybackStats(
  connection: PlaybackConnection,
  callback: () => ((stats: PlaybackStats | null) => void) | undefined,
  target: () => number | null | undefined,
): () => void {
  const { peer, displays } = connection;
  const reader = new PlaybackStatsReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let running = false;
  let busy = false;
  let generation = 0;
  let hasStats = false;
  let warned = false;
  const active = () => !disposed && !document.hidden && peer.connectionState === 'connected';
  const emit = (stats: PlaybackStats | null) => {
    if (!stats && !hasStats) return;
    hasStats = stats !== null;
    try {
      callback()?.(stats);
    } catch (error) {
      console.error('[RemoteControl] customer callback "onPlaybackStats" threw:', error);
    }
  };
  const stop = () => {
    running = false;
    generation++;
    clearTimeout(timer);
    reader.reset();
    emit(null);
  };
  const sample = async () => {
    if (busy || !active()) return;
    // A previous subscription may still be awaiting this peer's stats.
    if (inFlight.has(peer)) {
      timer = setTimeout(() => {
        void sample();
      }, 2000);
      return;
    }
    busy = true;
    inFlight.add(peer);
    const started = generation;
    try {
      const report = await peer.getStats();
      if (started !== generation || !active()) return;
      const receivers = peer
        .getTransceivers()
        .filter(
          (t) =>
            (t.currentDirection === 'recvonly' || t.currentDirection === 'sendrecv') &&
            t.receiver.track.readyState !== 'ended',
        )
        .map((t) => ({
          trackId: t.receiver.track.id,
          kind: t.receiver.track.kind,
          mid: t.mid,
          display: displays.get(t.receiver),
        }));
      emit(reader.read(report, receivers, target()));
      warned = false;
    } catch (error) {
      if (started !== generation || !active()) return;
      if (!warned) console.warn('[RemoteControl] could not read playback stats:', error);
      warned = true;
      reader.reset();
      emit(null);
    } finally {
      busy = false;
      inFlight.delete(peer);
      if (running && active())
        timer = setTimeout(
          () => {
            void sample();
          },
          started === generation ? 2000 : 0,
        );
    }
  };
  const sync = () => {
    if (!active()) {
      stop();
      return;
    }
    if (running) return;
    running = true;
    void sample();
  };
  document.addEventListener('visibilitychange', sync);
  peer.addEventListener('connectionstatechange', sync);
  sync();
  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', sync);
    peer.removeEventListener('connectionstatechange', sync);
    stop();
  };
}
