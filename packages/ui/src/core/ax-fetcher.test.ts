// Tests for the AxFetcher state machine. We mock the WebSocket boundary
// using a fake `send` function + manual `handleMessage` injection, and
// drive time via vitest's fake timers so the burst/backoff math is
// deterministic.
//
// Default environment is jsdom (see vitest.config.ts) — needed because
// AxFetcher relies on `window.setTimeout` / `requestAnimationFrame`.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AxFetcher, AxStatus } from './ax-fetcher';
import { AxSnapshot, AX_UNAVAILABLE_ERROR } from './ax-tree';

// ────────────────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────────────────

// Minimal iOS tree the server might return; one root with one child, both
// with usable frames. Used to verify normalizeIosTree wires through.
const iosTreeJson = JSON.stringify([
  {
    frame: { x: 0, y: 0, width: 100, height: 200 },
    type: 'Application',
    children: [
      {
        frame: { x: 10, y: 10, width: 50, height: 50 },
        type: 'Button',
        AXLabel: 'A',
        AXUniqueId: 'a',
      },
    ],
  },
]);

const androidPayload = {
  nodes: [
    // screen root
    { parsedBounds: { left: 0, top: 0, right: 1080, bottom: 2400, centerX: 540, centerY: 1200 } },
    // a child
    {
      resourceId: 'foo',
      className: 'android.widget.View',
      parsedBounds: { left: 100, top: 100, right: 200, bottom: 200, centerX: 150, centerY: 150 },
    },
  ],
};

interface Harness {
  fetcher: AxFetcher;
  send: ReturnType<typeof vi.fn>;
  onSnapshot: ReturnType<typeof vi.fn>;
  onStatusChange: ReturnType<typeof vi.fn>;
  // Pull the most recent request id we sent (for crafting responses).
  lastRequestId: () => string | null;
  // Helpers to feed a response.
  respondIos: (id: string, opts?: { error?: string; json?: string }) => void;
  respondAndroid: (id: string, opts?: { errorMessage?: string }) => void;
}

const makeIosHarness = (opts: { baseIntervalMs?: number; maxBackoffMs?: number } = {}): Harness => {
  const send = vi.fn((payload: Record<string, unknown>) => {
    // Accept all sends in tests; track by capturing the args.
    return true;
  });
  const onSnapshot = vi.fn();
  const onStatusChange = vi.fn();
  const fetcher = new AxFetcher({
    platform: 'ios',
    send,
    onSnapshot,
    onStatusChange,
    baseIntervalMs: opts.baseIntervalMs,
    maxBackoffMs: opts.maxBackoffMs,
  });
  const lastRequestId = (): string | null => {
    if (send.mock.calls.length === 0) return null;
    const last = send.mock.calls[send.mock.calls.length - 1]![0] as { id?: string };
    return last.id ?? null;
  };
  const respondIos: Harness['respondIos'] = (id, { error, json } = {}) => {
    fetcher.handleMessage({
      type: 'elementTreeResult',
      id,
      json: error ? undefined : json ?? iosTreeJson,
      error,
    });
  };
  const respondAndroid: Harness['respondAndroid'] = () => {
    throw new Error('android responses not available on an iOS harness');
  };
  return { fetcher, send, onSnapshot, onStatusChange, lastRequestId, respondIos, respondAndroid };
};

const makeAndroidHarness = (): Harness => {
  const send = vi.fn(() => true);
  const onSnapshot = vi.fn();
  const onStatusChange = vi.fn();
  const fetcher = new AxFetcher({
    platform: 'android',
    send,
    onSnapshot,
    onStatusChange,
  });
  const lastRequestId = (): string | null => {
    if (send.mock.calls.length === 0) return null;
    const last = send.mock.calls[send.mock.calls.length - 1]![0] as { id?: string };
    return last.id ?? null;
  };
  const respondIos: Harness['respondIos'] = () => {
    throw new Error('iOS responses not available on an android harness');
  };
  const respondAndroid: Harness['respondAndroid'] = (id, { errorMessage } = {}) => {
    fetcher.handleMessage({
      type: 'getElementTreeResult',
      id,
      payload: errorMessage ? undefined : androidPayload,
      error: errorMessage ? { message: errorMessage } : undefined,
    });
  };
  return { fetcher, send, onSnapshot, onStatusChange, lastRequestId, respondIos, respondAndroid };
};

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AxFetcher: basic lifecycle', () => {
  test('start() emits starting → ready status and delivers first snapshot', async () => {
    const h = makeIosHarness();
    h.fetcher.start();
    expect(h.fetcher.getStatus()).toBe('starting');
    expect(h.onStatusChange).toHaveBeenCalledWith('starting', undefined);

    // start() schedules an immediate runOnce, which calls send synchronously.
    expect(h.send).toHaveBeenCalledTimes(1);
    const id = h.lastRequestId();
    expect(id).toMatch(/^ax-rc-/);

    h.respondIos(id!);
    // Snapshot delivery happens after the promise chain resolves.
    await vi.runOnlyPendingTimersAsync();

    expect(h.onSnapshot).toHaveBeenCalledTimes(1);
    const snapshot = h.onSnapshot.mock.calls[0]![0] as AxSnapshot;
    expect(snapshot.platform).toBe('ios');
    expect(snapshot.elements).toHaveLength(1);
    expect(h.fetcher.getStatus()).toBe('ready');
    expect(h.onStatusChange).toHaveBeenLastCalledWith('ready', undefined);
  });

  test('stop() emits idle and a final null snapshot', async () => {
    const h = makeIosHarness();
    h.fetcher.start();
    h.respondIos(h.lastRequestId()!);
    await vi.runOnlyPendingTimersAsync();

    h.fetcher.stop();
    expect(h.fetcher.getStatus()).toBe('idle');
    expect(h.onStatusChange).toHaveBeenLastCalledWith('idle', undefined);
    expect(h.onSnapshot).toHaveBeenLastCalledWith(null);
  });

  test('start() is idempotent (subsequent start() during running is a no-op)', async () => {
    const h = makeIosHarness();
    h.fetcher.start();
    h.fetcher.start();
    h.fetcher.start();
    // Only one fetch in flight.
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe('AxFetcher: single-flight', () => {
  test('does not start a second fetch while the first is in flight', async () => {
    const h = makeIosHarness();
    h.fetcher.start();
    // Even if we advance time, no second send happens until the first resolves.
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.send).toHaveBeenCalledTimes(1);

    // Respond, advance one tick — single follow-up scheduled.
    h.respondIos(h.lastRequestId()!);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});

describe('AxFetcher: change-detect backoff', () => {
  test('emits onSnapshot only when content changes', async () => {
    const h = makeIosHarness({ baseIntervalMs: 100, maxBackoffMs: 1000 });
    h.fetcher.start();
    h.respondIos(h.lastRequestId()!);
    await vi.runOnlyPendingTimersAsync();
    expect(h.onSnapshot).toHaveBeenCalledTimes(1);

    // Same response on next poll — onSnapshot must NOT fire again.
    await vi.advanceTimersByTimeAsync(100);
    h.respondIos(h.lastRequestId()!);
    await vi.runOnlyPendingTimersAsync();
    expect(h.onSnapshot).toHaveBeenCalledTimes(1);

    // Different response — fires.
    await vi.advanceTimersByTimeAsync(200);
    h.respondIos(h.lastRequestId()!, {
      json: JSON.stringify([
        {
          frame: { x: 0, y: 0, width: 100, height: 200 },
          type: 'Application',
          children: [
            {
              frame: { x: 10, y: 10, width: 50, height: 50 },
              type: 'Button',
              AXLabel: 'B', // changed
              AXUniqueId: 'a',
            },
          ],
        },
      ]),
    });
    await vi.runOnlyPendingTimersAsync();
    expect(h.onSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('AxFetcher: unavailable status', () => {
  test('transitions to unavailable when the server reports AX is down', async () => {
    const h = makeIosHarness();
    h.fetcher.start();
    h.respondIos(h.lastRequestId()!, { error: AX_UNAVAILABLE_ERROR });
    await vi.runOnlyPendingTimersAsync();
    expect(h.fetcher.getStatus()).toBe('unavailable');
    expect(h.onStatusChange).toHaveBeenLastCalledWith('unavailable', AX_UNAVAILABLE_ERROR);
  });

  test('recovers to ready when a usable snapshot eventually arrives', async () => {
    const h = makeIosHarness();
    h.fetcher.start();
    h.respondIos(h.lastRequestId()!, { error: AX_UNAVAILABLE_ERROR });
    await vi.runOnlyPendingTimersAsync();
    expect(h.fetcher.getStatus()).toBe('unavailable');

    // Advance through the unavailable retry interval, then respond OK.
    await vi.advanceTimersByTimeAsync(5000);
    h.respondIos(h.lastRequestId()!);
    await vi.runOnlyPendingTimersAsync();
    expect(h.fetcher.getStatus()).toBe('ready');
  });
});

describe('AxFetcher: error path', () => {
  test('transient parse error transitions to `error` then recovers', async () => {
    const h = makeIosHarness({ baseIntervalMs: 100 });
    h.fetcher.start();
    // Send malformed JSON in the response.
    h.respondIos(h.lastRequestId()!, { json: 'not-json{' });
    await vi.runOnlyPendingTimersAsync();
    expect(h.fetcher.getStatus()).toBe('error');

    // Recover with a valid response.
    await vi.advanceTimersByTimeAsync(500);
    h.respondIos(h.lastRequestId()!);
    await vi.runOnlyPendingTimersAsync();
    expect(h.fetcher.getStatus()).toBe('ready');
  });
});

describe('AxFetcher: bumpActivity / boost window', () => {
  test('bumpActivity is a no-op when not running', () => {
    const h = makeIosHarness();
    h.fetcher.bumpActivity();
    expect(h.send).toHaveBeenCalledTimes(0);
  });

  test('boosted cadence (~250 ms) is used while in the boost window', async () => {
    const h = makeIosHarness({ baseIntervalMs: 500 });
    h.fetcher.start();
    expect(h.send).toHaveBeenCalledTimes(1);

    // Bump while the initial fetch is still inflight. Bump can't trigger
    // its own immediate send (inflight is true) but must extend the boost
    // window so the NEXT scheduled fetch lands at ~250 ms rather than the
    // base 500 ms.
    h.fetcher.bumpActivity();
    expect(h.send).toHaveBeenCalledTimes(1);

    // Resolve the inflight — deliver+scheduleNext run on microtask. Flush
    // microtasks without advancing the clock so scheduling happens but no
    // timer has fired yet.
    h.respondIos(h.lastRequestId()!);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // At t = 0+ε, no boosted timer has fired yet (it's scheduled at 250ms).
    expect(h.send).toHaveBeenCalledTimes(1);

    // At t = 240 ms, still under the boosted interval — no fire.
    await vi.advanceTimersByTimeAsync(240);
    expect(h.send).toHaveBeenCalledTimes(1);

    // At t = 260 ms (past 250ms), the boosted timer fires.
    await vi.advanceTimersByTimeAsync(30);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  test('outside the boost window, cadence returns to base interval', async () => {
    const h = makeIosHarness({ baseIntervalMs: 500 });
    h.fetcher.start();
    h.respondIos(h.lastRequestId()!);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // No bumpActivity was called, so we're not in boost. Wait 240 ms — no
    // fire yet (base interval is 500ms).
    await vi.advanceTimersByTimeAsync(240);
    expect(h.send).toHaveBeenCalledTimes(1);

    // Wait another 280ms to clear 500ms — base-interval fetch fires.
    await vi.advanceTimersByTimeAsync(280);
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});

describe('AxFetcher: handleMessage routing', () => {
  test('iOS handleMessage ignores wrong-platform message shapes', () => {
    const h = makeIosHarness();
    h.fetcher.start();
    const consumed = h.fetcher.handleMessage({
      type: 'getElementTreeResult', // wrong for iOS
      id: h.lastRequestId()!,
      payload: { nodes: [] },
    });
    expect(consumed).toBe(false);
    // Cleanup: respond properly so we don't leave a pending timer.
    h.respondIos(h.lastRequestId()!);
  });

  test('Android handleMessage parses payload.nodes', async () => {
    const h = makeAndroidHarness();
    h.fetcher.start();
    h.respondAndroid(h.lastRequestId()!);
    await vi.runOnlyPendingTimersAsync();
    expect(h.onSnapshot).toHaveBeenCalledTimes(1);
    const snap = h.onSnapshot.mock.calls[0]![0] as AxSnapshot;
    expect(snap.platform).toBe('android');
  });

  test('returns false for unknown request ids', () => {
    const h = makeIosHarness();
    h.fetcher.start();
    expect(h.fetcher.handleMessage({ type: 'elementTreeResult', id: 'nope' })).toBe(false);
  });
});

describe('AxFetcher: refresh()', () => {
  test('triggers a one-shot fetch and dedupes via change-detect', async () => {
    const h = makeIosHarness({ baseIntervalMs: 10_000 }); // long base, no spontaneous polls
    h.fetcher.start();
    h.respondIos(h.lastRequestId()!);
    // Flush microtasks without advancing time so the next poll isn't tripped.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.onSnapshot).toHaveBeenCalledTimes(1);
    const sendsBefore = h.send.mock.calls.length;

    // Call refresh — initiates another fetch.
    const p = h.fetcher.refresh();
    expect(h.send.mock.calls.length).toBe(sendsBefore + 1);
    h.respondIos(h.lastRequestId()!);
    const snapshot = await p;
    expect(snapshot.platform).toBe('ios');
    // Identical content → no extra onSnapshot.
    expect(h.onSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('AxFetcher: status callback safety', () => {
  test('a throw in onStatusChange does not break the state machine', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const onStatusChange = vi.fn(() => {
        throw new Error('boom');
      });
      const send = vi.fn(() => true);
      const onSnapshot = vi.fn();
      const fetcher = new AxFetcher({
        platform: 'ios',
        send,
        onSnapshot,
        onStatusChange: onStatusChange as unknown as (s: AxStatus, e?: string) => void,
      });
      fetcher.start();
      expect(fetcher.getStatus()).toBe('starting');
      // Calling stop() would re-trigger the throwing callback — must not throw.
      expect(() => fetcher.stop()).not.toThrow();

      // The inflight request will time out asynchronously and call
      // setStatus('error'), which also goes through the throwing callback.
      // Drain that path while the spy is still in place to keep stderr
      // clean for the rest of the suite.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
