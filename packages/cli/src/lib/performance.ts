import type { PerformanceSample, PerformanceThread } from '@limrun/api';

/** One app's figures over a window of samples, as `lim ios perf --since` reports them. */
export type AppPerformanceSummary = {
  bundleId: string;
  /** The latest process; it changes when the app relaunches inside the window. */
  pid: number;
  testRunner?: boolean;
  samples: number;
  /** Average and highest CPU over the window; one busy core is 100. */
  cpuPercent?: { average: number; max: number };
  /** The footprint at the latest sample. */
  footprintBytes: number;
  /** The highest footprint any process of the app reached in the window. */
  peakFootprintBytes: number;
  threadCount: number;
};

/** Each app's newest sample, newest launch first, optionally only one bundle ID. */
export function latestPerApp(samples: PerformanceSample[], bundleId?: string): PerformanceSample[] {
  const latest = new Map<string, PerformanceSample>();
  for (const sample of samples) {
    if (bundleId && sample.bundleId !== bundleId) continue;
    const previous = latest.get(sample.bundleId);
    if (!previous || sample.ts >= previous.ts) latest.set(sample.bundleId, sample);
  }
  return [...latest.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The samples in the last `windowMs` before the newest one. The window is measured on the
 * instance's clock, which every sample's ts uses, so the caller's clock never matters.
 */
export function samplesInWindow(
  samples: PerformanceSample[],
  windowMs: number,
  bundleId?: string,
): PerformanceSample[] {
  const newest = samples.reduce((max, sample) => Math.max(max, sample.ts), Number.NEGATIVE_INFINITY);
  return samples.filter(
    (sample) => sample.ts >= newest - windowMs && (!bundleId || sample.bundleId === bundleId),
  );
}

/** Per-app summaries of a window of samples, in latestPerApp's order. */
export function summarize(samples: PerformanceSample[]): AppPerformanceSummary[] {
  return latestPerApp(samples).map((latest) => {
    const own = samples.filter((sample) => sample.bundleId === latest.bundleId);
    const cpu = own
      .map((sample) => sample.cpuPercent)
      .filter((value): value is number => value !== undefined);
    return {
      bundleId: latest.bundleId,
      pid: latest.pid,
      ...(latest.testRunner && { testRunner: true }),
      samples: own.length,
      ...(cpu.length > 0 && {
        cpuPercent: {
          average: Math.round((cpu.reduce((sum, value) => sum + value, 0) / cpu.length) * 10) / 10,
          max: Math.max(...cpu),
        },
      }),
      footprintBytes: latest.footprintBytes,
      peakFootprintBytes: Math.max(...own.map((sample) => sample.peakFootprintBytes)),
      threadCount: latest.threadCount,
    };
  });
}

/** "main 52.1%, worker 20.4%", or "-" when no thread used measurable CPU. */
export function formatThreads(threads: PerformanceThread[] | undefined, limit = 3): string {
  if (!threads || threads.length === 0) return '-';
  return threads
    .slice(0, limit)
    .map((thread) => `${thread.name || 'unnamed'} ${thread.cpuPercent.toFixed(1)}%`)
    .join(', ');
}

export function formatPercent(value: number | undefined): string {
  return value === undefined ? '-' : `${value.toFixed(1)}%`;
}
