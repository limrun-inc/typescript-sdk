import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class IosLog extends BaseCommand {
  static summary = 'Stream or tail app logs from a running iOS instance';
  static aliases = ['exec log'];
  static examples = [
    '<%= config.bin %> ios log <instance-ID> com.example.app',
    '<%= config.bin %> ios log <instance-ID> com.example.app --lines 50',
    '<%= config.bin %> ios log <instance-ID> com.example.app -f',
  ];

  static args = {
    bundleId: Args.string({ description: 'App bundle identifier', required: true }),
    id: Args.string({ description: 'Instance ID (defaults to last created)', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    follow: Flags.boolean({ char: 'f', description: 'Stream logs continuously', default: false }),
    lines: Flags.integer({ description: 'Number of lines to tail (non-streaming)', default: 100 }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosLog);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
      // Log tail (non-streaming) can use session
      if (!flags.follow) {
        if (hasActiveSession(id)) {
          const output = await sendSessionCommand(id, 'app-log-tail', [args.bundleId, flags.lines]);
          this.log(String(output));
        } else {
          const { type, client, disconnect } = await getInstanceClient(this.client, id);
          if (type !== 'ios') {
            disconnect();
            this.error('log command is only supported on iOS instances');
          }
          try {
            const output = await (client as any).appLogTail(args.bundleId, flags.lines);
            this.log(output);
          } finally {
            disconnect();
          }
        }
        return;
      }

      // Streaming requires direct connection (long-lived)
      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      if (type !== 'ios') {
        disconnect();
        this.error('log command is only supported on iOS instances');
      }

      try {
        const logStream = (client as any).streamAppLog(args.bundleId);
        logStream.on('line', (line: string) => {
          process.stdout.write(line + '\n');
        });
        logStream.on('error', (err: Error) => {
          this.warn(`Log stream error: ${err.message}`);
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
