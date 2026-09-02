import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidLogcat extends BaseCommand {
  static summary = 'Run logcat on a running Android instance';
  static description =
    'Run logcat on a running Android instance without needing adb locally. ' +
    'Arguments are forwarded to logcat verbatim, so its usual flags and filter expressions work: ' +
    '`-d` or `-t 50` dumps and exits, `-T 50` follows, no arguments dumps the buffer and follows. ' +
    'Put logcat arguments after `--` so they are not parsed as CLI flags. ' +
    "The CLI exits with logcat's exit code, or streams until interrupted.";

  // Logcat owns the argument vocabulary; everything after `--` passes through.
  static strict = false;

  static examples = [
    '<%= config.bin %> android logcat',
    '<%= config.bin %> android logcat -- -t 50',
    '<%= config.bin %> android logcat -- -T 50 *:E',
    '<%= config.bin %> android logcat --id <instance-ID> -- -s MyTag',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const parsed = await this.parse(AndroidLogcat);
    const flags = parsed.flags;
    const args = (parsed.argv as string[]) ?? [];
    this.setParsedFlags(flags as Record<string, unknown>);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        const logcat = client.logcat(args);
        let interrupted = false;
        let streamError: Error | undefined;

        logcat.on('line', (line: string) => {
          if (flags.json) {
            this.outputJson({ line });
          } else {
            process.stdout.write(line + '\n');
          }
        });
        logcat.on('error', (err: Error) => {
          streamError = err;
          if (!interrupted) {
            this.warn(`logcat: ${err.message}`);
          }
        });

        const onSignal = () => {
          interrupted = true;
          logcat.stop();
        };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        const exitCode = await logcat.wait();
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);

        if (interrupted) {
          return;
        }
        if (exitCode === -1 && streamError) {
          this.error(streamError.message);
        }
        if (exitCode !== 0) {
          this.exit(exitCode > 0 ? exitCode : 1);
        }
      } finally {
        disconnect();
      }
    });
  }
}
