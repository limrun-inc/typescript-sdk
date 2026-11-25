import type { PerformanceSample } from '@limrun/api';
import { formatBinaryBytes } from './bytes';
import { formatDurationMs } from './duration';
import { formatPercent, formatThreads, latestPerApp, samplesInWindow, summarize } from './performance';

// What `lim ios perf` and `lim macos perf` share: both instances sample every app once a second,
// keep ten minutes of history and replay it when a stream opens.

// The instance replays its history in one burst when the stream opens, says when the replay
// ends, then sends each app's sample once a second. Runtimes that predate that signal end the
// burst with a pause instead. Live samples arrive once a second, so the pause must stay shorter
// than that, or a running app would keep the history read open forever.
const REPLAY_GAP_MS = 700;
// With no sample by then, no app is running.
const NO_SAMPLES_MS = 5_000;
// A sample at most this old is current: --follow prints it even inside the replay, and an app
// whose newest sample is older has stopped.
const CURRENT_MS = 5_000;
// The instance keeps this much history.
export const HISTORY_SECONDS = 600;
export const HISTORY = `${HISTORY_SECONDS / 60}m`;

function formatRate(bytesPerSecond: number | undefined): string {
  return bytesPerSecond === undefined ? '-' : `${formatBinaryBytes(bytesPerSecond)}/s`;
}

/** The bundle ID, noting a test runner and an app that stopped reporting `ageMs` ago. */
function appLabel(app: { bundleId: string; testRunner?: boolean }, ageMs = 0): string {
  const notes = [
    app.testRunner && 'test runner',
    ageMs > CURRENT_MS && `stopped ${formatDurationMs(Math.round(ageMs / 1000) * 1000)} ago`,
  ].filter(Boolean);
  return notes.length > 0 ? `${app.bundleId} (${notes.join(', ')})` : app.bundleId;
}

/** Opens a performance stream and returns the function that closes it. */
export type OpenPerformanceStream = (handlers: {
  onSample: (sample: PerformanceSample) => void;
  onReplayed: () => void;
  onError: (error: Error) => void;
}) => () => void;

/** Where a report prints: the command's output methods. */
export interface PerformanceOutput {
  outputJson(value: unknown): void;
  outputEvent(value: unknown): void;
  outputTable(headers: string[], rows: string[][]): void;
  info(message: string): void;
}

/**
 * Prints the apps' latest samples, or a summary of the last `windowSeconds`, from the history the
 * instance replays, as `perf` does without --follow.
 */
export async function reportPerformance(
  open: OpenPerformanceStream,
  out: PerformanceOutput,
  options: {
    app: string | undefined;
    windowSeconds: number | undefined;
    since: string | undefined;
    json: boolean;
  },
): Promise<void> {
  const window = samplesInWindow(
    await readHistory(open),
    (options.windowSeconds ?? HISTORY_SECONDS) * 1000,
    options.app,
  );
  if (window.length === 0 && !options.json) {
    const span = options.since ?? HISTORY;
    out.info(
      options.app ?
        `${options.app} reported no performance in the last ${span}. Only apps you install are measured.`
      : `No app reported performance in the last ${span}. Only apps you install are measured.`,
    );
    return;
  }
  if (options.windowSeconds === undefined) {
    printLatest(out, latestPerApp(window), options.json);
  } else {
    printSummary(out, window, options.json);
  }
}

/** Reads the history the instance replays on connect, then closes the stream. */
function readHistory(open: OpenPerformanceStream): Promise<PerformanceSample[]> {
  const samples: PerformanceSample[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  return new Promise<PerformanceSample[]>((resolve, reject) => {
    const finish = () => resolve(samples);
    timer = setTimeout(finish, NO_SAMPLES_MS);
    stop = open({
      onSample: (sample) => {
        samples.push(sample);
        clearTimeout(timer);
        timer = setTimeout(finish, REPLAY_GAP_MS);
      },
      onReplayed: finish,
      onError: reject,
    });
  }).finally(() => {
    clearTimeout(timer);
    stop();
  });
}

function printLatest(out: PerformanceOutput, latest: PerformanceSample[], json: boolean): void {
  if (json) {
    out.outputJson(latest);
    return;
  }
  const now = Date.now();
  out.outputTable(
    ['App', 'CPU', 'Memory', 'Peak', 'Threads', 'Disk read', 'Disk write', 'Busiest threads'],
    latest.map((sample) => [
      appLabel(sample, now - sample.ts),
      formatPercent(sample.cpuPercent),
      formatBinaryBytes(sample.footprintBytes),
      formatBinaryBytes(sample.peakFootprintBytes),
      String(sample.threadCount),
      formatRate(sample.diskReadBytesPerSecond),
      formatRate(sample.diskWriteBytesPerSecond),
      formatThreads(sample.topThreads),
    ]),
  );
}

function printSummary(out: PerformanceOutput, window: PerformanceSample[], json: boolean): void {
  const summaries = summarize(window);
  if (json) {
    out.outputJson(summaries);
    return;
  }
  out.outputTable(
    ['App', 'Samples', 'Avg CPU', 'Max CPU', 'Memory', 'Max memory', 'Threads'],
    summaries.map((summary) => [
      appLabel(summary),
      String(summary.series.length),
      formatPercent(summary.cpuPercent?.average),
      formatPercent(summary.cpuPercent?.max),
      formatBinaryBytes(summary.footprintBytes),
      formatBinaryBytes(summary.maxFootprintBytes),
      String(summary.threadCount),
    ]),
  );
}

/**
 * Prints each new sample until interrupted. The replayed history is skipped, except samples
 * current enough to show the apps' present state.
 */
export async function followPerformance(
  open: OpenPerformanceStream,
  out: PerformanceOutput,
  app: string | undefined,
  json: boolean,
): Promise<void> {
  let replayed = false;
  let gap: ReturnType<typeof setTimeout> | undefined;
  let interrupted = () => {};
  let stop = () => {};
  // Keeps the process waiting for Ctrl+C while the stream reconnects.
  const keepAlive = setInterval(() => {}, 1 << 30);
  try {
    await new Promise<void>((resolve, reject) => {
      interrupted = () => resolve();
      process.once('SIGINT', interrupted);
      process.once('SIGTERM', interrupted);
      stop = open({
        onSample: (sample) => {
          if (!replayed) {
            clearTimeout(gap);
            gap = setTimeout(() => (replayed = true), REPLAY_GAP_MS);
            if (Date.now() - sample.ts > CURRENT_MS) return;
          }
          if (app && sample.bundleId !== app) return;
          printSample(out, sample, json);
        },
        onReplayed: () => {
          replayed = true;
          clearTimeout(gap);
        },
        onError: reject,
      });
    });
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    clearTimeout(gap);
    clearInterval(keepAlive);
    stop();
  }
}

function printSample(out: PerformanceOutput, sample: PerformanceSample, json: boolean): void {
  if (json) {
    out.outputEvent(sample);
    return;
  }
  const time = new Date(sample.ts).toTimeString().slice(0, 8);
  process.stdout.write(
    `${time} ${sample.bundleId} cpu ${formatPercent(sample.cpuPercent)} ` +
      `mem ${formatBinaryBytes(sample.footprintBytes)} peak ${formatBinaryBytes(
        sample.peakFootprintBytes,
      )} ` +
      `threads ${sample.threadCount} busiest ${formatThreads(sample.topThreads, 2)}\n`,
  );
}
