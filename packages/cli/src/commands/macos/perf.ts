import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseDurationSeconds } from '../../lib/duration';
import {
  HISTORY,
  HISTORY_SECONDS,
  followPerformance,
  reportPerformance,
  type OpenPerformanceStream,
  type PerformanceOutput,
} from '../../lib/performance-report';

export default class MacosPerf extends BaseCommand {
  static summary = 'Show the CPU and memory of apps running on a macOS instance';
  static description =
    "Print each running app's CPU, memory footprint and its peak, thread count, disk rates and busiest " +
    'threads. The instance samples every app in an Applications folder once a second and keeps the last ten ' +
    'minutes, so the command answers at once and exits. Apps that stopped in that time are listed as stopped, ' +
    'and CPU counts one busy core as 100%.\n\n' +
    'Use --since to summarize part of that history, and --follow to stream new samples until interrupted. ' +
    'Saved captures come from `lim macos create --perf`; list them with `lim macos perf-captures`.';
  static examples = [
    '<%= config.bin %> macos perf',
    '<%= config.bin %> macos perf --app com.apple.TextEdit --since 2m',
    '<%= config.bin %> macos perf --follow',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    app: Flags.string({ description: 'Only report this bundle ID.' }),
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
    const { flags } = await this.parse(MacosPerf);
    this.setParsedFlags(flags);
    const windowSeconds = flags.since ? parseDurationSeconds(flags.since) : undefined;
    if (windowSeconds !== undefined && windowSeconds > HISTORY_SECONDS) {
      this.error(`--since can reach back at most ${HISTORY}; the instance keeps no more history.`);
    }
    await this.withAuth(async () => {
      const { client } = await this.resolveMacosClient(flags.id);
      const open: OpenPerformanceStream = (handlers) =>
        client.streamPerformance({
          onEntry: handlers.onSample,
          onReplayed: handlers.onReplayed,
          onError: handlers.onError,
        });
      const out: PerformanceOutput = {
        outputJson: (value) => this.outputJson(value),
        outputEvent: (value) => this.outputEvent(value),
        outputTable: (headers, rows) => this.outputTable(headers, rows),
        info: (message) => this.info(message),
      };
      if (flags.follow) {
        await followPerformance(open, out, flags.app, flags.json);
        return;
      }
      await reportPerformance(open, out, {
        app: flags.app,
        windowSeconds,
        since: flags.since,
        json: flags.json,
        measured: 'Only apps in an Applications folder are measured.',
      });
    });
  }
}
