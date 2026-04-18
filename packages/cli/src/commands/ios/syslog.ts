import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { detectInstanceType, getInstanceClient } from '../../lib/instance-client-factory';

export default class IosSyslog extends BaseCommand {
  static summary = 'Stream syslog from a running iOS instance';
  static description =
    'Stream simulator syslog lines from a running iOS instance until interrupted. This is useful for low-level debugging beyond app-specific stdout/stderr.';
  static examples = [
    '<%= config.bin %> ios syslog',
    '<%= config.bin %> ios syslog --id <instance-ID>',
    '<%= config.bin %> ios syslog --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosSyslog);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios syslog only supports iOS instances');
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      if (type !== 'ios') {
        disconnect();
        this.error('ios syslog only supports iOS instances');
      }

      try {
        const stream = (client as any).streamSyslog();
        stream.on('line', (line: string) => {
          if (flags.json) {
            this.outputJson({ line });
          } else {
            process.stdout.write(line + '\n');
          }
        });
        stream.on('error', (err: Error) => {
          this.warn(`Syslog stream error: ${err.message}`);
        });

        await new Promise<void>((resolve) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          const shutdown = () => {
            clearInterval(keepAlive);
            stream.stop();
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
