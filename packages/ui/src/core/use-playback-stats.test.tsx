import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePlaybackStats, type PlaybackConnection } from './use-playback-stats';
import type { PlaybackStats } from './playback-stats';

class Peer extends EventTarget {
  connectionState = 'connected';
  getStats = vi.fn(
    async () =>
      new Map([
        [
          'video',
          {
            id: 'video',
            type: 'inbound-rtp',
            kind: 'video',
            ssrc: 123,
            trackIdentifier: 'video0',
            timestamp: Date.now(),
            framesDecoded: Date.now() / 20,
          },
        ],
      ]) as unknown as RTCStatsReport,
  );
  getTransceivers = () => [
    {
      currentDirection: 'recvonly',
      mid: '0',
      receiver: { track: { id: 'video0', kind: 'video', readyState: 'live' } },
    },
    {
      currentDirection: 'sendonly',
      mid: '1',
      receiver: { track: { id: 'camera', kind: 'video', readyState: 'live' } },
    },
  ];
  state(value: string) {
    this.connectionState = value;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}
let root: ReturnType<typeof createRoot>;
let peer: Peer;
let connection: PlaybackConnection;
let hidden: boolean;
const callback = vi.fn<(stats: PlaybackStats | null) => void>();
function View({
  cb = callback,
  target = 50,
  source = connection,
}: {
  cb?: ((stats: PlaybackStats | null) => void) | null;
  target?: number | null;
  source?: PlaybackConnection | null;
}) {
  usePlaybackStats(source, cb ?? undefined, target);
  return null;
}
async function render(props: React.ComponentProps<typeof View> = {}) {
  await act(async () => root.render(<View {...props} />));
}
async function advance(ms = 2000) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
async function visible(value: boolean) {
  await act(async () => {
    hidden = !value;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  peer = new Peer();
  connection = { peer: peer as unknown as RTCPeerConnection, displays: new Map() };
  callback.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('does no work without a subscriber and stops when unsubscribed', async () => {
  await render({ cb: null });
  await advance(10000);
  expect(peer.getStats).not.toHaveBeenCalled();
  await render();
  expect(peer.getStats).toHaveBeenCalledTimes(1);
  expect(callback.mock.lastCall![0]!.video[0].fps).toBeUndefined();
  await advance();
  expect(callback.mock.lastCall![0]!.video[0].fps).toBe(50);
  await render({ cb: null });
  const calls = peer.getStats.mock.calls.length;
  await advance(10000);
  expect(peer.getStats).toHaveBeenCalledTimes(calls);
});

it('uses the latest callback without restarting the baseline or sampling loop', async () => {
  await render();
  const next = vi.fn();
  await render({ cb: next });
  expect(peer.getStats).toHaveBeenCalledTimes(1);
  await advance();
  expect(next.mock.lastCall![0].video[0].fps).toBe(50);
  expect(callback).toHaveBeenCalledTimes(1);
});

it('keeps measurements and cadence when changing or clearing the buffer target', async () => {
  await render();
  await advance();
  await render({ target: 0 });
  expect(peer.getStats).toHaveBeenCalledTimes(2);
  expect(callback).toHaveBeenCalledTimes(2);
  await advance();
  expect(callback.mock.lastCall![0]).toMatchObject({
    requestedTargetMs: 0,
    video: [{ intervalMs: 2000, fps: 50 }],
  });
  await render({ target: null });
  expect(peer.getStats).toHaveBeenCalledTimes(3);
  expect(callback).toHaveBeenCalledTimes(3);
  await advance();
  expect(callback.mock.lastCall![0]).toMatchObject({
    requestedTargetMs: null,
    video: [{ intervalMs: 2000, fps: 50 }],
  });
  expect(callback.mock.calls.every(([sample]) => sample !== null)).toBe(true);
});

it('pauses when hidden or disconnected and establishes a fresh baseline on resume', async () => {
  await render();
  await advance();
  await visible(false);
  expect(callback.mock.lastCall![0]).toBeNull();
  const count = peer.getStats.mock.calls.length;
  await advance(10000);
  expect(peer.getStats).toHaveBeenCalledTimes(count);
  await visible(true);
  expect(callback.mock.lastCall![0]!.video[0].fps).toBeUndefined();
  await act(async () => peer.state('disconnected'));
  expect(callback.mock.lastCall![0]).toBeNull();
  await advance();
  expect(peer.getStats).toHaveBeenCalledTimes(count + 1);
  await act(async () => peer.state('connected'));
  expect(callback.mock.lastCall![0]!.video[0].fps).toBeUndefined();
});

it('ignores late results after reconnecting and samples the new peer independently', async () => {
  let resolve!: (report: RTCStatsReport) => void;
  peer.getStats.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await advance(6000);
  expect(peer.getStats).toHaveBeenCalledTimes(1);
  const fresh = new Peer();
  await render({ source: { peer: fresh as unknown as RTCPeerConnection, displays: new Map() } });
  expect(callback).toHaveBeenCalledTimes(1);
  await act(async () => resolve(new Map() as unknown as RTCStatsReport));
  expect(callback).toHaveBeenCalledTimes(1);
  await advance();
  expect(callback.mock.lastCall![0]!.video[0].fps).toBe(50);
});

it('does not overlap pending requests when the target or subscription changes', async () => {
  let resolve!: (report: RTCStatsReport) => void;
  peer.getStats.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await render({ target: 0 });
  await render({ cb: null });
  await render({ target: 0 });
  await advance(6000);
  expect(peer.getStats).toHaveBeenCalledTimes(1);
  await act(async () => resolve(new Map() as unknown as RTCStatsReport));
  expect(callback).not.toHaveBeenCalled();
  await advance();
  expect(callback.mock.lastCall![0]).toMatchObject({ requestedTargetMs: 0 });
  expect(callback.mock.lastCall![0]!.video[0].fps).toBeUndefined();
});

it('clears failed samples, recovers, and isolates customer callback exceptions', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await render();
  peer.getStats.mockRejectedValueOnce(new Error('Stats unavailable'));
  await advance();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(callback.mock.lastCall![0]).toBeNull();
  callback.mockImplementationOnce(() => {
    throw new Error('Customer failure');
  });
  await advance();
  expect(error).toHaveBeenCalledTimes(1);
  await advance();
  expect(callback.mock.lastCall![0]!.video[0].fps).toBe(50);
});

it('does not collect before connected and sends one null when the peer is removed', async () => {
  peer.state('connecting');
  await render();
  await advance();
  expect(peer.getStats).not.toHaveBeenCalled();
  await act(async () => peer.state('connected'));
  await render({ source: null });
  expect(callback.mock.calls.filter(([sample]) => sample === null)).toHaveLength(1);
});
