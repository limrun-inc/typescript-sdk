import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AndroidConnect extends BaseCommand {
  static summary = 'Connect to an existing Android instance via ADB tunnel';
  static description =
    'Open a long-lived ADB tunnel to a running Android instance so local tools can talk to it as if it were attached over USB. The command stays running until you stop it. For scripts and agents, prefer passing `--id` explicitly.';
  static examples = [
    '<%= config.bin %> android connect',
    '<%= config.bin %> android connect --id <ID>',
    '<%= config.bin %> android connect --id android_abc123 --adb-path /opt/homebrew/bin/adb',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Android instance ID to connect to. Defaults to the last created Android instance, but `--id` is recommended for scripts and agents.',
    }),
    'adb-path': Flags.string({
      description: 'Path to the adb binary available on your machine',
      default: 'adb',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidConnect);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      const instance = await this.client.androidInstances.get(id);
      if (!instance.status.apiUrl) {
        this.error(`Instance ${id} does not have an apiUrl. Is it ready?`);
      }

      const { createInstanceClient } = await import('@limrun/api');
      const instanceClient = await createInstanceClient({
        apiUrl: instance.status.apiUrl,
        adbUrl: instance.status.adbWebSocketUrl,
        token: instance.status.token,
      });

      const tunnel = await instanceClient.startAdbTunnel();
      this.log('Tunnel started. Press Ctrl+C to stop.');

      await new Promise<void>((resolve) => {
        const keepAlive = setInterval(() => {}, 1 << 30);
        const shutdown = () => {
          clearInterval(keepAlive);
          this.log('Stopping tunnel...');
          resolve();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });

      tunnel.close();
      instanceClient.disconnect();
    });
  }
}
