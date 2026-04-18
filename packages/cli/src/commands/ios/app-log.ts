import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class IosAppLog extends BaseCommand {
  static summary = 'Stream or tail app logs from a running iOS instance';
  static description =
    'Read logs for a specific installed app on a running iOS instance. Use `--tail` for recent lines, or `--follow` to keep streaming logs until you stop the command.';
  static examples = [
    '<%= config.bin %> ios app-log com.example.app',
    '<%= config.bin %> ios app-log com.example.app --tail 50',
    '<%= config.bin %> ios app-log com.example.app --follow --id <instance-ID>',
  ];

  static args = {
    bundleId: Args.string({
      description: 'Bundle identifier of the installed app whose logs should be read',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
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
    const { args, flags } = await this.parse(IosAppLog);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);

      if (!flags.follow) {
        if (hasActiveSession(id)) {
          const output = await sendSessionCommand(id, 'app-log-tail', [args.bundleId, flags.tail]);
          this.log(String(output));
        } else {
          const { type, client, disconnect } = await getInstanceClient(this.client, id);
          if (type !== 'ios') {
            disconnect();
            this.error('app-log command is only supported on iOS instances');
          }
          try {
            const output = await (client as any).appLogTail(args.bundleId, flags.tail);
            this.log(output);
          } finally {
            disconnect();
          }
        }
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      if (type !== 'ios') {
        disconnect();
        this.error('app-log command is only supported on iOS instances');
      }

      try {
        const logStream = (client as any).streamAppLog(args.bundleId);
        logStream.on('line', (line: string) => {
          process.stdout.write(line + '\n');
        });
        logStream.on('error', (err: Error) => {
          this.warn(`App log stream error: ${err.message}`);
        });

        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          const shutdown = () => {
            clearInterval(keepAlive);
            logStream.stop();
            resolve();
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        });
      } finally {
        disconnect();
      }
    });
  }
}
