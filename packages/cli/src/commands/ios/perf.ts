import { Flags } from '@oclif/core';
import { SessionStreamRejectedError } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { parseDurationSeconds } from '../../lib/duration';
import { resolveIosConnection, streamIosPerformance } from '../../lib/instance-client-factory';
import {
  HISTORY,
  HISTORY_SECONDS,
  followPerformance,
  reportPerformance,
  type OpenPerformanceStream,
  type PerformanceOutput,
} from '../../lib/performance-report';

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

    // A replacement has no apps to measure, so a deleted instance is reported, not replaced.
    await this.withAuth(
      async () => {
        const resolvedInstance = this.resolveIosInstance(flags.id);
        const connection = await resolveIosConnection(this.client, resolvedInstance);
        try {
          const open: OpenPerformanceStream = (handlers) => streamIosPerformance(connection, handlers);
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
            measured: 'Only apps you install are measured.',
          });
        } catch (err) {
          if (err instanceof SessionStreamRejectedError && err.status === 404) {
            // The router answers 404 for a deleted instance, and a runtime for a stream it lacks. The
            // API tells which: a deleted instance throws NotFoundError here, which withAuth reports.
            await this.client.iosInstances.get(resolvedInstance.id);
            this.error(
              'This instance runs a runtime from before app performance. Create a new instance to measure its apps.',
            );
          }
          throw err;
        }
      },
      { createReplacement: false },
    );
  }
}
