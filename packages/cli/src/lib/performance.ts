import type { PerformanceSample, PerformanceThread } from '@limrun/api';

/** One app's figures over a window of samples, as `lim ios perf --since` reports them. */
export type AppPerformanceSummary = {
  bundleId: string;
  /** The latest process; it changes when the app relaunches inside the window. */
  pid: number;
  testRunner?: boolean;
  /** Average and highest CPU over the window; one busy core is 100. */
  cpuPercent?: { average: number; max: number };
  /** The footprint at the latest sample. */
  footprintBytes: number;
  /**
   * The highest footprint sampled in the window. Each sample's peakFootprintBytes covers its
   * whole process lifetime, which can predate the window.
   */
  maxFootprintBytes: number;
  threadCount: number;
  /** The app's samples in the window, oldest first. */
  series: PerformanceSample[];
};

/** Each app's newest sample, newest launch first. */
export function latestPerApp(samples: PerformanceSample[]): PerformanceSample[] {
  const latest = new Map<string, PerformanceSample>();
  for (const sample of samples) {
    const previous = latest.get(sample.bundleId);
    if (!previous || sample.ts >= previous.ts) latest.set(sample.bundleId, sample);
  }
  return [...latest.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** The samples taken in the last `windowMs` before `now`, optionally only one bundle ID. */
export function samplesInWindow(
  samples: PerformanceSample[],
  windowMs: number,
  bundleId?: string,
  now = Date.now(),
): PerformanceSample[] {
  return samples.filter(
    (sample) => sample.ts > now - windowMs && (!bundleId || sample.bundleId === bundleId),
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
      ...(cpu.length > 0 && {
        cpuPercent: {
          average: Math.round((cpu.reduce((sum, value) => sum + value, 0) / cpu.length) * 10) / 10,
          max: Math.max(...cpu),
        },
      }),
      footprintBytes: latest.footprintBytes,
      maxFootprintBytes: Math.max(...own.map((sample) => sample.footprintBytes)),
      threadCount: latest.threadCount,
      series: own,
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
