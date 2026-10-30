import { describe, expect, it } from 'vitest';
import { PlaybackStatsReader, type PlaybackReceiver } from './playback-stats';

const receivers: PlaybackReceiver[] = [
  { trackId: 'video0', kind: 'video', mid: '1', display: 'primary' },
  { trackId: 'audio0', kind: 'audio', mid: '0' },
];
function inbound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in-video',
    type: 'inbound-rtp',
    kind: 'video',
    ssrc: 123,
    trackIdentifier: 'video0',
    transportId: 'transport',
    timestamp: 1000,
    framesDecoded: 100,
    framesDropped: 2,
    freezeCount: 0,
    bytesReceived: 10000,
    jitterBufferDelay: 10,
    jitterBufferEmittedCount: 100,
    ...overrides,
  };
}
function report(...entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((entry) => [entry.id, entry])) as unknown as RTCStatsReport;
}

describe('incoming playback measurements', () => {
  it.each(['VP9', 'H264', 'H265'])('derives interval measurements independently of the %s codec', (codec) => {
    const reader = new PlaybackStatsReader();
    const first = reader.read(report(inbound({ codecId: codec })), receivers, 50)!;
    expect(first.video[0]).toEqual({
      id: 'in-video',
      trackId: 'video0',
      display: 'primary',
      timestamp: 1000,
    });
    const sample = reader.read(
      report(
        inbound({
          timestamp: 3000,
          framesDecoded: 218,
          framesDropped: 5,
          freezeCount: 1,
          bytesReceived: 510000,
          jitterBufferDelay: 18.16,
          jitterBufferEmittedCount: 220,
        }),
        { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
        { id: 'selected', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.043 },
        {
          id: 'unused',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          currentRoundTripTime: 5,
        },
        { id: 'camera', type: 'outbound-rtp', kind: 'video', framesEncoded: 99999 },
        { id: 'remote-camera', type: 'remote-inbound-rtp', kind: 'video', framesDecoded: 99999 },
      ),
      receivers,
      50,
    )!;
    expect(sample).toMatchObject({
      requestedTargetMs: 50,
      timestamp: 3000,
      rttMs: 43,
      audio: [],
      video: [{ intervalMs: 2000, fps: 59, droppedFrames: 3, freezes: 1, bitrateBps: 2000000 }],
    });
    expect(sample.video[0].bufferDelayMs).toBeCloseTo(68);
  });

  it('keeps both Duo displays and audio separate and ignores outgoing receiver slots', () => {
    const reader = new PlaybackStatsReader();
    const tracks = [
      ...receivers,
      { trackId: 'duo-inner', kind: 'video', mid: '2', display: 'inner' as const },
    ];
    const entries = (timestamp: number, frames: number) =>
      report(
        inbound({ timestamp, framesDecoded: frames }),
        inbound({
          id: 'inner',
          trackIdentifier: 'duo-inner',
          ssrc: 456,
          timestamp,
          framesDecoded: frames * 2,
        }),
        inbound({ id: 'audio', trackIdentifier: 'audio0', kind: 'audio', timestamp }),
        inbound({ id: 'unused-camera', trackIdentifier: 'local-camera', timestamp }),
      );
    reader.read(entries(1000, 100), tracks, undefined);
    const result = reader.read(entries(3000, 110), tracks, undefined)!;
    expect(result.video.map((v) => [v.display, v.fps])).toEqual([
      ['primary', 5],
      ['inner', 10],
    ]);
    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]).not.toHaveProperty('fps');
    expect(result.requestedTargetMs).toBeNull();
  });

  it('does not invent zeroes for missing fields, a cached report, or a zero-frame interval', () => {
    const reader = new PlaybackStatsReader();
    reader.read(report(inbound()), receivers, null);
    expect(reader.read(report(inbound()), receivers, null)!.video[0].intervalMs).toBeUndefined();
    const sample = reader.read(
      report(inbound({ timestamp: 3000, framesDropped: undefined, freezeCount: undefined })),
      receivers,
      null,
    )!;
    expect(sample.video[0]).toMatchObject({ fps: 0, bitrateBps: 0, intervalMs: 2000 });
    expect(sample.video[0].bufferDelayMs).toBeUndefined();
    expect(sample.video[0].droppedFrames).toBeUndefined();
    expect(sample.video[0].freezes).toBeUndefined();
    expect(sample.rttMs).toBeUndefined();
  });

  it('resets baselines on SSRC changes, track replacements, absent streams and explicit reset', () => {
    const reader = new PlaybackStatsReader();
    reader.read(report(inbound()), receivers, 0);
    expect(
      reader.read(report(inbound({ timestamp: 3000, ssrc: 456 })), receivers, 0)!.video[0].fps,
    ).toBeUndefined();
    const replaced = [{ trackId: 'new-video', kind: 'video', mid: '1' }];
    expect(
      reader.read(report(inbound({ timestamp: 5000, ssrc: 456, trackIdentifier: 'new-video' })), replaced, 0)!
        .video[0].fps,
    ).toBeUndefined();
    expect(reader.read(report(), receivers, null)).toBeNull();
    expect(
      reader.read(report(inbound({ timestamp: 7000 })), receivers, null)!.video[0].intervalMs,
    ).toBeUndefined();
    reader.reset();
    expect(
      reader.read(report(inbound({ timestamp: 9000 })), receivers, null)!.video[0].intervalMs,
    ).toBeUndefined();
  });

  it('discards regressing counters and nonfinite values without corrupting later samples', () => {
    const reader = new PlaybackStatsReader();
    reader.read(report(inbound()), receivers, undefined);
    const bad = reader.read(
      report(
        inbound({
          timestamp: 3000,
          framesDecoded: 2,
          framesDropped: NaN,
          bytesReceived: Infinity,
          jitterBufferDelay: 1,
          jitterBufferEmittedCount: 3,
        }),
      ),
      receivers,
      NaN,
    )!;
    expect(bad.video[0].fps).toBeUndefined();
    expect(bad.video[0].bufferDelayMs).toBeUndefined();
    expect(bad.video[0].bitrateBps).toBeUndefined();
    expect(bad.requestedTargetMs).toBeUndefined();
    expect(
      reader.read(report(inbound({ timestamp: 5000, framesDecoded: 122 })), receivers, 50)!.video[0].fps,
    ).toBe(60);
  });

  it('supports older browser track association by mid, without guessing between Duo tracks', () => {
    const reader = new PlaybackStatsReader();
    expect(
      reader.read(
        report(inbound({ kind: undefined, mediaType: 'video', trackIdentifier: undefined, mid: '1' })),
        receivers,
        50,
      )!.video[0].trackId,
    ).toBe('video0');
    expect(reader.read(report(inbound({ trackIdentifier: undefined })), receivers, 50)!.video).toHaveLength(
      1,
    );
    expect(
      reader.read(
        report(inbound({ trackIdentifier: undefined })),
        [...receivers, { trackId: 'duo-inner', kind: 'video', mid: '2' }],
        50,
      ),
    ).toBeNull();
    expect(reader.read(report(inbound({ trackIdentifier: 'unrelated' })), receivers, 50)).toBeNull();
  });
});
