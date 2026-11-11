import type { PerformanceSample } from '@limrun/api';
import { formatThreads, latestPerApp, samplesInWindow, summarize } from './performance';

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
    const series = [
      // The process peaked at 500 MB before the window, so its lifetime peak is not the window's.
      sample(0, { peakFootprintBytes: 500 * MB }),
      sample(1000, { cpuPercent: 100, footprintBytes: 300 * MB, peakFootprintBytes: 500 * MB }),
      sample(2000, { cpuPercent: 300, peakFootprintBytes: 500 * MB }),
      sample(3000, { pid: 101, cpuPercent: 20, footprintBytes: 60 * MB, peakFootprintBytes: 60 * MB }),
    ];
    expect(summarize([...series, sample(3000, { bundleId: 'com.example.other' })])[0]).toEqual({
      bundleId: 'com.example.app',
      pid: 101,
      cpuPercent: { average: 140, max: 300 },
      footprintBytes: 60 * MB,
      maxFootprintBytes: 300 * MB,
      threadCount: 12,
      series,
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
