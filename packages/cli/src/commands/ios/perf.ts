import { Flags } from '@oclif/core';
import type { Ios, PerformanceSample } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { formatBinaryBytes } from '../../lib/bytes';
import { formatDurationMs, parseDurationSeconds } from '../../lib/duration';
import { getIosInstanceClient } from '../../lib/instance-client-factory';
import {
  formatPercent,
  formatThreads,
  latestPerApp,
  samplesInWindow,
  summarize,
} from '../../lib/performance';

// The instance replays its history in one burst when the stream opens, then sends each app's
// sample once a second. A pause this long ends the burst.
const REPLAY_GAP_MS = 700;
// With no sample by then, no app reports: none is running, or the instance predates performance.
const NO_SAMPLES_MS = 5_000;
// A sample at most this old is current: --follow prints it even inside the replay, and an app
// whose newest sample is older has stopped.
const CURRENT_MS = 5_000;
// The instance keeps this much history.
const HISTORY_SECONDS = 600;
const HISTORY = `${HISTORY_SECONDS / 60}m`;

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

export default class IosPerf extends BaseCommand {
  static summary = 'Show the CPU and memory of apps running on an iOS instance';
  static description =
    "Print each app's CPU, memory footprint and its peak, thread count, disk rates and busiest " +
    "threads: the figures Xcode's debug gauges show. The instance samples every app you installed once a " +
    'second and keeps the last ten minutes, so the command answers at once and exits. Apps that stopped ' +
    'in that time are listed as stopped. System apps are not measured, and CPU counts one busy core as 100%.\n\n' +
    'Use --since to summarize part of that history (average and highest CPU, highest memory), and --follow to ' +
    'stream new samples until interrupted. Saved captures come from `lim ios create --perf`; list them with ' +
    '`lim ios perf-captures`.';
  static examples = [
    '<%= config.bin %> ios perf',
    '<%= config.bin %> ios perf --app com.example.myapp --since 2m',
    '<%= config.bin %> ios perf --since 5m --json',
    '<%= config.bin %> ios perf --follow',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    app: Flags.string({
      description: 'Only report this bundle ID.',
    }),
    since: Flags.string({
      description: `Summarize this much recent history, as a duration like 2m or 30s (at most ${HISTORY}).`,
      exclusive: ['follow'],
    }),
    follow: Flags.boolean({
      description: 'Stream new samples, one per app per second, until interrupted.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosPerf);
    this.setParsedFlags(flags);
    const windowSeconds = flags.since ? parseDurationSeconds(flags.since) : undefined;
    if (windowSeconds !== undefined && windowSeconds > HISTORY_SECONDS) {
      this.error(`--since can reach back at most ${HISTORY}; the instance keeps no more history.`);
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        if (flags.follow) {
          await this.follow(client, flags.app, flags.json);
          return;
        }
        const window = samplesInWindow(
          await this.readHistory(client),
          (windowSeconds ?? HISTORY_SECONDS) * 1000,
          flags.app,
        );
        if (window.length === 0 && !flags.json) {
          const span = flags.since ?? HISTORY;
          this.info(
            flags.app ?
              `${flags.app} reported no performance in the last ${span}. Only apps you install are measured.`
            : `No app reported performance in the last ${span}. Only apps you install are measured, and older instances report nothing.`,
          );
          return;
        }
        if (windowSeconds === undefined) {
          this.printLatest(latestPerApp(window), flags.json);
        } else {
          this.printSummary(window, flags.json);
        }
      } finally {
        disconnect();
      }
    });
  }

  /** Reads the history the instance replays on connect, then closes the stream. */
  private readHistory(client: Ios.InstanceClient): Promise<PerformanceSample[]> {
    const samples: PerformanceSample[] = [];
    return new Promise((resolve, reject) => {
      const finish = () => {
        stop();
        resolve(samples);
      };
      let timer = setTimeout(finish, NO_SAMPLES_MS);
      const stop = client.streamPerformance({
        onSample: (sample) => {
          samples.push(sample);
          clearTimeout(timer);
          timer = setTimeout(finish, REPLAY_GAP_MS);
        },
        onError: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  private printLatest(latest: PerformanceSample[], json: boolean): void {
    if (json) {
      this.outputJson(latest);
      return;
    }
    const now = Date.now();
    this.outputTable(
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

  private printSummary(window: PerformanceSample[], json: boolean): void {
    const summaries = summarize(window);
    if (json) {
      this.outputJson(summaries);
      return;
    }
    this.outputTable(
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
  private async follow(client: Ios.InstanceClient, app: string | undefined, json: boolean): Promise<void> {
    let replayed = false;
    let gap: ReturnType<typeof setTimeout> | undefined;
    let stop = () => {};
    // Keeps the process waiting for Ctrl+C while the stream reconnects.
    const keepAlive = setInterval(() => {}, 1 << 30);
    try {
      await new Promise<void>((resolve, reject) => {
        stop = client.streamPerformance({
          onSample: (sample) => {
            if (!replayed) {
              clearTimeout(gap);
              gap = setTimeout(() => (replayed = true), REPLAY_GAP_MS);
              if (Date.now() - sample.ts > CURRENT_MS) return;
            }
            if (app && sample.bundleId !== app) return;
            this.printSample(sample, json);
          },
          onError: reject,
        });
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      });
    } finally {
      clearTimeout(gap);
      clearInterval(keepAlive);
      stop();
    }
  }

  private printSample(sample: PerformanceSample, json: boolean): void {
    if (json) {
      this.outputEvent(sample);
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
}
