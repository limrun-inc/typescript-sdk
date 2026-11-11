import type { PerformanceSample } from '@limrun/api';
import { formatThreads, latestPerApp, samplesInWindow, summarize } from './performance';
import { startPersistedCaptures } from './session-captures';

const MB = 1024 * 1024;

function sample(ts: number, overrides: Partial<PerformanceSample> = {}): PerformanceSample {
  return {
    ts,
    bundleId: 'com.example.app',
    pid: 100,
    startedAt: 0,
    footprintBytes: 100 * MB,
    peakFootprintBytes: 120 * MB,
    threadCount: 12,
    ...overrides,
  };
}

describe('performance samples', () => {
  it('reports each app by its newest sample, newest launch first', () => {
    const latest = latestPerApp([
      sample(1000, { bundleId: 'com.example.old', startedAt: 0 }),
      sample(2000, { bundleId: 'com.example.app', startedAt: 500, cpuPercent: 40 }),
      sample(3000, { bundleId: 'com.example.old', startedAt: 0, threadCount: 30 }),
    ]);
    expect(latest.map((s) => [s.bundleId, s.ts])).toEqual([
      ['com.example.app', 2000],
      ['com.example.old', 3000],
    ]);
  });

  it('keeps the samples taken within the window before now', () => {
    const samples = [0, 30_000, 60_000, 90_000, 120_000].map((ts) => sample(ts));
    expect(samplesInWindow(samples, 60_000, undefined, 120_000).map((s) => s.ts)).toEqual([90_000, 120_000]);
    // Samples stay in the instance's buffer after every app stops; they are not recent.
    expect(samplesInWindow(samples, 60_000, undefined, 600_000)).toEqual([]);
    expect(samplesInWindow(samples, 60_000, 'com.example.other', 120_000)).toEqual([]);
  });

  it('summarizes CPU and the highest memory in the window across a relaunch', () => {
    const [summary] = summarize([
      // The process peaked at 500 MB before the window, so its lifetime peak is not the window's.
      sample(0, { peakFootprintBytes: 500 * MB }),
      sample(1000, { cpuPercent: 100, footprintBytes: 300 * MB, peakFootprintBytes: 500 * MB }),
      sample(2000, { cpuPercent: 300, peakFootprintBytes: 500 * MB }),
      sample(3000, { pid: 101, cpuPercent: 20, footprintBytes: 60 * MB, peakFootprintBytes: 60 * MB }),
    ]);
    expect(summary).toEqual({
      bundleId: 'com.example.app',
      pid: 101,
      samples: 4,
      cpuPercent: { average: 140, max: 300 },
      footprintBytes: 60 * MB,
      peakFootprintBytes: 300 * MB,
      threadCount: 12,
    });
  });

  it('names the busiest threads, or a dash when none used measurable CPU', () => {
    expect(
      formatThreads([
        { name: 'main', cpuPercent: 52.06 },
        { name: '', cpuPercent: 20.4 },
        { name: 'a', cpuPercent: 3 },
        { name: 'b', cpuPercent: 1 },
      ]),
    ).toBe('main 52.1%, unnamed 20.4%, a 3.0%');
    expect(formatThreads(undefined)).toBe('-');
  });
});

describe('startPersistedCaptures --perf', () => {
  const base = {
    startRecording: jest.fn(),
    startAppLogCapture: jest.fn(),
    startEventCapture: jest.fn(),
  };

  it('starts a performance capture with the requested TTL', async () => {
    const startPerformanceCapture = jest.fn();
    const started = await startPersistedCaptures(
      { ...base, startPerformanceCapture },
      { record: false, events: false, performance: true, ttlSeconds: 3600 },
    );
    expect(startPerformanceCapture).toHaveBeenCalledWith({ ttlSeconds: 3600 });
    expect(started).toEqual(['performance capture']);
  });

  it('refuses on a client that cannot save performance', async () => {
    await expect(
      startPersistedCaptures(base, { record: false, events: false, performance: true, ttlSeconds: 3600 }),
    ).rejects.toThrow('Only iOS instances save performance captures.');
  });
});
