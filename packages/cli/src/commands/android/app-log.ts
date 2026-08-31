import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidAppLog extends BaseCommand {
  static summary = 'Stream or tail app logs from a running Android instance';
  static description =
    'Read logcat output for a specific installed app on a running Android instance. ' +
    'Use `--tail` for recent lines of the running app, or `--follow` to keep streaming ' +
    'logs until you stop the command.';
  static examples = [
    '<%= config.bin %> android app-log com.example.app',
    '<%= config.bin %> android app-log com.example.app --tail 50',
    '<%= config.bin %> android app-log com.example.app --follow --id <instance-ID>',
  ];

  static args = {
    packageName: Args.string({
      description: 'Package name of the installed app whose logs should be read',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    follow: Flags.boolean({
      char: 'f',
      description: 'Keep streaming log lines until interrupted',
      default: false,
    }),
    tail: Flags.integer({
      char: 'n',
      description: 'Number of recent lines to fetch when not using `--follow`.',
      default: 100,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidAppLog);
    this.setParsedFlags(flags);

    // The package name is interpolated into a shell command below, so only
    // accept the characters valid in Android package names.
    if (!/^[A-Za-z0-9._]+$/.test(args.packageName)) {
      this.error(`Invalid package name: ${args.packageName}`);
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);

      if (!flags.follow) {
        try {
          // logcat has no per-package filter, only per-pid, so resolve the
          // app's main pid first. Logs of an app that is not running are
          // not retrievable this way; --follow does not have that limit.
          const result = await client.adbShell('sh', [
            '-c',
            `pid="$(pidof -s ${args.packageName})" || { echo "${args.packageName} is not running; start it or use --follow." >&2; exit 1; }; ` +
              `logcat -d --pid "$pid" -t ${flags.tail}`,
          ]);
          if (result.stdout) {
            process.stdout.write(result.stdout);
          }
          if (result.stderr) {
            process.stderr.write(result.stderr);
          }
          if (result.exitCode !== 0) {
            this.exit(result.exitCode);
          }
        } finally {
          disconnect();
        }
        return;
      }

      try {
        // The live stream is fed by an app log capture. Start a live-only
        // one; if a capture is already active for this package (e.g.
        // started by `android create --app-logs`), attach to its stream
        // instead and leave it running on exit. The instance rejects a
        // second capture with the active package's name, which is also how
        // an already-active failure is told apart from a transient one.
        let startedCapture = false;
        try {
          await client.startAppLogCapture({ bundleId: args.packageName });
          startedCapture = true;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const active = /already active for (\S+)/.exec(message)?.[1];
          if (!active) {
            this.error(`Could not start an app log capture: ${message}`);
          }
          if (active !== args.packageName) {
            this.error(
              `An app log capture is already active for ${active} and only one runs at a time; ` +
                `run \`lim android app-log ${active} --follow\` to tail it.`,
            );
          }
          this.warn(`Attaching to the app log capture already active for ${active}.`);
        }

        const closeStream = client.streamAppLogCapture({
          onLine: (line) => {
            process.stdout.write(line.line + '\n');
          },
          onError: (err: Error) => {
            this.warn(`App log stream error: ${err.message}`);
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

        closeStream();
        if (startedCapture) {
          try {
            await client.stopAppLogCapture();
          } catch {
            // The instance may already be gone; nothing to clean up then.
          }
        }
      } finally {
        disconnect();
      }
    });
  }
}
