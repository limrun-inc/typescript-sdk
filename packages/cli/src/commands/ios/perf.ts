import { Flags } from '@oclif/core';
import type { Ios, PerformanceSample } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { formatBytes } from '../../lib/bytes';
import { parseDurationSeconds } from '../../lib/duration';
import { getIosInstanceClient } from '../../lib/instance-client-factory';
import {
  formatPercent,
  formatThreads,
  latestPerApp,
  samplesInWindow,
  summarize,
} from '../../lib/performance';

// The instance replays its history in one burst right after the stream opens; this long after
// the first sample the burst has arrived.
const REPLAY_SETTLE_MS = 1_500;
// With no sample by then, no app reports: none is running, or the instance predates performance.
const NO_SAMPLES_MS = 5_000;
// The instance keeps this much history.
const HISTORY_SECONDS = 600;

/** Megabytes the way Xcode's memory gauge and the console count them. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRate(bytesPerSecond: number | undefined): string {
  return bytesPerSecond === undefined ? '-' : `${formatBytes(bytesPerSecond)}/s`;
}

export default class IosPerf extends BaseCommand {
  static summary = 'Show the CPU and memory of apps running on an iOS instance';
  static description =
    "Print each running app's CPU, memory footprint and its peak, thread count, disk rates and busiest " +
    "threads: the figures Xcode's debug gauges show. The instance samples every app you installed once a " +
    'second and keeps the last ten minutes, so the command answers at once and exits. System apps are not ' +
    'measured, and CPU counts one busy core as 100%.\n\n' +
    'Use --since to summarize part of that history (average and highest CPU, peak memory), and --follow to ' +
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
      description: `Summarize this much recent history, as a duration like 2m or 30s (at most ${
        HISTORY_SECONDS / 60
      }m).`,
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
      this.error(
        `--since can reach back at most ${HISTORY_SECONDS / 60}m; the instance keeps no more history.`,
      );
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        if (flags.follow) {
          await this.follow(client, flags.app, flags.json);
          return;
        }
        const history = await this.readHistory(client);
        if (latestPerApp(history, flags.app).length === 0) {
          if (flags.json) {
            this.outputJson([]);
            return;
          }
          this.info(
            flags.app ?
              `${flags.app} reported no performance in the last ${
                HISTORY_SECONDS / 60
              } minutes. Only apps you install are measured.`
            : 'No app is reporting performance. Only apps you install are measured, and older instances report nothing.',
          );
          return;
        }
        if (windowSeconds === undefined) {
          this.printLatest(latestPerApp(history, flags.app), flags.json);
        } else {
          this.printSummary(samplesInWindow(history, windowSeconds * 1000, flags.app), flags.json);
        }
      } finally {
        disconnect();
      }
    });
  }

  /** Reads the history the instance replays on connect, then closes the stream. */
  private readHistory(client: Ios.InstanceClient): Promise<PerformanceSample[]> {
    const samples: PerformanceSample[] = [];
    return new Promise((resolve) => {
      let settle: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(settle);
        clearTimeout(idle);
        stop();
        resolve(samples);
      };
      const idle = setTimeout(finish, NO_SAMPLES_MS);
      const stop = client.streamPerformance({
        onSample: (sample) => {
          samples.push(sample);
          settle ??= setTimeout(finish, REPLAY_SETTLE_MS);
        },
        onError: (err) => {
          this.warn(`Performance stream error: ${err.message}`);
          finish();
        },
      });
    });
  }

  private printLatest(latest: PerformanceSample[], json: boolean): void {
    if (json) {
      this.outputJson(latest);
      return;
    }
    this.outputTable(
      ['App', 'CPU', 'Memory', 'Peak', 'Threads', 'Disk read', 'Disk write', 'Busiest threads'],
      latest.map((sample) => [
        sample.testRunner ? `${sample.bundleId} (test runner)` : sample.bundleId,
        formatPercent(sample.cpuPercent),
        formatMegabytes(sample.footprintBytes),
        formatMegabytes(sample.peakFootprintBytes),
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
      this.outputJson(
        summaries.map((summary) => ({
          ...summary,
          series: window.filter((sample) => sample.bundleId === summary.bundleId),
        })),
      );
      return;
    }
    this.outputTable(
      ['App', 'Samples', 'Avg CPU', 'Max CPU', 'Memory', 'Peak', 'Threads'],
      summaries.map((summary) => [
        summary.testRunner ? `${summary.bundleId} (test runner)` : summary.bundleId,
        String(summary.samples),
        formatPercent(summary.cpuPercent?.average),
        formatPercent(summary.cpuPercent?.max),
        formatMegabytes(summary.footprintBytes),
        formatMegabytes(summary.peakFootprintBytes),
        String(summary.threadCount),
      ]),
    );
  }

  /** Prints each new sample until interrupted, skipping the history replayed on connect. */
  private async follow(client: Ios.InstanceClient, app: string | undefined, json: boolean): Promise<void> {
    let liveAfter: number | undefined;
    const stop = client.streamPerformance({
      onSample: (sample) => {
        const now = Date.now();
        liveAfter ??= now + REPLAY_SETTLE_MS;
        if (now < liveAfter || (app && sample.bundleId !== app)) return;
        if (json) {
          this.outputEvent(sample);
          return;
        }
        const time = new Date(sample.ts).toISOString().slice(11, 19);
        process.stdout.write(
          `${time} ${sample.bundleId} cpu ${formatPercent(sample.cpuPercent)} ` +
            `mem ${formatMegabytes(sample.footprintBytes)} peak ${formatMegabytes(
              sample.peakFootprintBytes,
            )} ` +
            `threads ${sample.threadCount} busiest ${formatThreads(sample.topThreads, 2)}\n`,
        );
      },
      onError: (err) => {
        this.warn(`Performance stream error: ${err.message}`);
      },
    });
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => {}, 1 << 30);
      const shutdown = () => {
        clearInterval(keepAlive);
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    stop();
  }
}
