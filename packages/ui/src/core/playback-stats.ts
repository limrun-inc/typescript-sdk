/** Measurements for one incoming RTP stream. Missing browser fields stay undefined. */
export interface PlaybackTrackStats {
  /** Browser stats identity. Changes when the RTP stream is replaced. */
  id: string;
  trackId: string;
  /** Browser collection time in Unix milliseconds. */
  timestamp: number;
  /** Time between this stream's samples. Absent on the first sample. */
  intervalMs?: number;
  /** Average receiving-side buffer delay over the interval, not end-to-end latency. */
  bufferDelayMs?: number;
  /** Received media bitrate over the interval, in bits per second. */
  bitrateBps?: number;
}

export interface PlaybackVideoStats extends PlaybackTrackStats {
  /** The main display, or the independently streamed inner display on iPhone Duo. */
  display: 'primary' | 'inner';
  /** Decoded frames per second over the interval. Static screens may send few frames. */
  fps?: number;
  /** Frames dropped during the interval, as reported by the browser. */
  droppedFrames?: number;
  /** Browser-reported freezes completed during the interval. */
  freezes?: number;
}

export type PlaybackAudioStats = PlaybackTrackStats;

export interface PlaybackStats {
  /** Latest incoming-stream collection time in Unix milliseconds. */
  timestamp: number;
  /** Configured preference; null means automatic. Absent when the prop is invalid. */
  requestedTargetMs?: number | null;
  /** Current round-trip time of the selected ICE pair, when reported by the browser. */
  rttMs?: number;
  /** Separate measurements for each incoming display; never sum their frame rates. */
  video: PlaybackVideoStats[];
  audio: PlaybackAudioStats[];
}

export interface PlaybackReceiver {
  trackId: string;
  kind: string;
  mid: string | null;
  display?: PlaybackVideoStats['display'];
}

type InboundStats = RTCInboundRtpStreamStats & { mediaType?: string };
type Previous = { stats: InboundStats; trackId: string };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function delta(current: unknown, previous: unknown): number | undefined {
  if (!finite(current) || !finite(previous) || current < previous || previous < 0) return undefined;
  return current - previous;
}

/** Keep baselines per stream so reconnects and Duo displays cannot contaminate each other. */
export class PlaybackStatsReader {
  private previous = new Map<string, Previous>();

  reset(): void {
    this.previous.clear();
  }

  read(
    report: RTCStatsReport,
    receivers: PlaybackReceiver[],
    target: number | null | undefined,
  ): PlaybackStats | null {
    const result: PlaybackStats = { timestamp: 0, video: [], audio: [] };
    if (target == null) result.requestedTargetMs = null;
    else if (finite(target) && target >= 0 && target <= 4000) result.requestedTargetMs = target;
    const next = new Map<string, Previous>();

    report.forEach((entry: InboundStats) => {
      if (entry.type !== 'inbound-rtp' || !finite(entry.timestamp)) return;
      const kind = entry.kind ?? entry.mediaType;
      if (kind !== 'video' && kind !== 'audio') return;
      const candidates = receivers.filter((receiver) => receiver.kind === kind);
      const receiver =
        entry.trackIdentifier ? candidates.find((candidate) => candidate.trackId === entry.trackIdentifier)
        : entry.mid != null ? candidates.find((candidate) => candidate.mid === entry.mid)
        : candidates.length === 1 ? candidates[0]
        : undefined;
      if (!receiver) return;

      const previous = this.previous.get(entry.id);
      const sameStream = previous?.trackId === receiver.trackId && previous.stats.ssrc === entry.ssrc;
      const before = sameStream ? previous.stats : undefined;
      const interval = before ? entry.timestamp - before.timestamp : undefined;
      const track: PlaybackTrackStats = {
        id: entry.id,
        trackId: receiver.trackId,
        timestamp: entry.timestamp,
      };
      if (interval !== undefined && interval > 0) {
        track.intervalMs = interval;
        const emitted = delta(entry.jitterBufferEmittedCount, before?.jitterBufferEmittedCount);
        const delay = delta(entry.jitterBufferDelay, before?.jitterBufferDelay);
        if (emitted !== undefined && emitted > 0 && delay !== undefined)
          track.bufferDelayMs = (delay / emitted) * 1000;
        const bytes = delta(entry.bytesReceived, before?.bytesReceived);
        if (bytes !== undefined) track.bitrateBps = (bytes * 8000) / interval;
      }
      if (kind === 'video') {
        const video: PlaybackVideoStats = { ...track, display: receiver.display ?? 'primary' };
        if (track.intervalMs !== undefined) {
          const decoded = delta(entry.framesDecoded, before?.framesDecoded);
          if (decoded !== undefined) video.fps = (decoded * 1000) / track.intervalMs;
          video.droppedFrames = delta(entry.framesDropped, before?.framesDropped);
          video.freezes = delta(entry.freezeCount, before?.freezeCount);
        }
        result.video.push(video);
      } else result.audio.push(track);
      result.timestamp = Math.max(result.timestamp, entry.timestamp);
      // Cached or out-of-order reports must not move the baseline backwards.
      next.set(
        entry.id,
        before && entry.timestamp <= before.timestamp ?
          previous!
        : { stats: entry, trackId: receiver.trackId },
      );

      const transport =
        entry.transportId ? (report.get(entry.transportId) as RTCTransportStats | undefined) : undefined;
      const pair =
        transport?.selectedCandidatePairId ?
          (report.get(transport.selectedCandidatePairId) as RTCIceCandidatePairStats | undefined)
        : undefined;
      if (
        pair?.state === 'succeeded' &&
        finite(pair.currentRoundTripTime) &&
        pair.currentRoundTripTime >= 0
      ) {
        result.rttMs = pair.currentRoundTripTime * 1000;
      }
    });
    this.previous = next;
    return result.video.length || result.audio.length ? result : null;
  }
}
