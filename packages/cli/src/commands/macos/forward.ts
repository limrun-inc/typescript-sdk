import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parsePortMapping } from '../../lib/port-mapping';

export default class MacosForward extends BaseCommand {
  static summary = 'Access a server inside a macOS instance through localhost';
  static description =
    'Forward a local TCP port to a server running inside the macOS guest, such as a web app, an API or a database. ' +
    'The listener binds to 127.0.0.1 and stays running until Ctrl+C. ' +
    'The server must listen on the guest loopback, 127.0.0.1 or ::1, or on all interfaces. ' +
    'Start it separately, for example with lim macos run. UDP is not supported.';
  static examples = [
    '<%= config.bin %> macos forward 3000',
    '<%= config.bin %> macos forward 8080:3000 --id <instance-ID>',
    '<%= config.bin %> macos forward 0:5432 --json',
  ];

  static args = {
    mapping: Args.string({
      description:
        'Port mapping as <port> or <localPort>:<remotePort>. Use local port 0 to choose an available port.',
      required: true,
    }),
  };

  static flags = {
    'api-key': BaseCommand.baseFlags['api-key'],
    json: BaseCommand.baseFlags.json,
    quiet: BaseCommand.baseFlags.quiet,
    workspace: BaseCommand.baseFlags.workspace,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosForward);
    this.setParsedFlags(flags);
    const { localPort, remotePort } = parsePortMapping(args.mapping);

    await this.withAuth(
      async () => {
        const { id, client } = await this.resolveMacosClient(flags.id);
        const tunnel = await client.startPortForward(localPort, remotePort, { logLevel: 'none' });
        try {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              unsubscribe();
              process.off('SIGINT', shutdown);
              process.off('SIGTERM', shutdown);
            };
            const shutdown = () => {
              cleanup();
              resolve();
            };
            const disconnected = () => {
              cleanup();
              reject(new Error('Port forward disconnected. Run lim macos forward again to reconnect.'));
            };
            const unsubscribe = tunnel.onConnectionStateChange((state) => {
              if (state === 'disconnected') disconnected();
              if (state === 'reconnecting') this.info('Port forward reconnecting...');
            });
            process.once('SIGINT', shutdown);
            process.once('SIGTERM', shutdown);
            if (tunnel.getConnectionState() === 'disconnected') {
              disconnected();
              return;
            }
            const ready = {
              instanceId: id,
              localHost: tunnel.address.address,
              localPort: tunnel.address.port,
              remotePort,
            };
            try {
              if (flags.json) {
                this.outputJson(ready);
              } else {
                this.output(`${ready.localHost}:${ready.localPort} -> ${id}:${remotePort}`);
                this.info('Port forward started. Press Ctrl+C to stop.');
              }
            } catch (err) {
              cleanup();
              reject(err);
            }
          });
        } finally {
          tunnel.close();
        }
        // A replacement instance would not contain the server the user is forwarding.
      },
      { createReplacement: false },
    );
  }
}
