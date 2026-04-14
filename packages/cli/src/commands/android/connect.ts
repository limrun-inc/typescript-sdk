import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class AndroidConnect extends BaseCommand {
  static summary = 'Connect to an existing Android instance via ADB tunnel';
  static aliases = ['connect android'];
  static examples = ['<%= config.bin %> android connect', '<%= config.bin %> android connect --id <ID>'];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Android instance ID (defaults to last created)' }),
    'adb-path': Flags.string({ description: 'Path to adb binary', default: 'adb' }),
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
