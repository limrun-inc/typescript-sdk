import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { inheritedFlags, startDetached } from '../../lib/detached';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidConnect extends BaseCommand {
  static summary = 'Connect to an existing Android instance via ADB tunnel';
  static description =
    'Open a long-lived ADB tunnel to a running Android instance so local tools can talk to it as if it were attached over USB. The tunnel runs in a background process that the command prints the PID of; stop it with kill <pid>, or pass --no-detach to keep it in the foreground until Ctrl+C. For scripts and agents, prefer passing `--id` explicitly.';
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
    detach: Flags.boolean({
      description:
        'Run the ADB tunnel in a background process and return once it is up. Use --no-detach to stay in the foreground until Ctrl+C.',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidConnect);
    this.setParsedFlags(flags);

    if (flags.detach) {
      const id = this.resolveAndroidInstance(flags.id).id;
      const { pid, logPath, ready } = await startDetached({
        name: `android-connect-${id}`,
        args: ['android', 'connect', '--id', id, '--adb-path', flags['adb-path'], ...inheritedFlags(flags)],
      });
      const address = ready['address'] as { address?: string; port?: number } | undefined;
      this.outputResult(
        { ...ready, pid, logPath },
        `Tunnel started on ${address?.address}:${address?.port} in the background. Stop it with kill ${pid}.`,
      );
      return;
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const id = resolvedInstance.id;
      const { client } = await getAndroidInstanceClient(this.client, resolvedInstance);

      const tunnel = await client.startAdbTunnel();
      this.outputResult(
        { instanceId: id, address: tunnel.address },
        `Tunnel started on ${tunnel.address.address}:${tunnel.address.port}. Press Ctrl+C to stop.`,
      );

      await new Promise<void>((resolve) => {
        const keepAlive = setInterval(() => {}, 1 << 30);
        const shutdown = () => {
          clearInterval(keepAlive);
          this.info('Stopping tunnel...');
          resolve();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });

      tunnel.close();
      client.disconnect();
    });
  }
}
