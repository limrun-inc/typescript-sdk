import { Args, Flags } from '@oclif/core';
import { startTcpTunnel } from '@limrun/api/tunnel';
import { BaseCommand } from '../../base-command';
import { resolveIosConnection } from '../../lib/instance-client-factory';

function parseMapping(mapping: string): { localPort: number; remotePort: number } {
  if (!/^\d+(?::\d+)?$/.test(mapping)) {
    throw new Error('Mapping must be <port> or <localPort>:<remotePort>.');
  }
  const [local, remote = local] = mapping.split(':');
  const localPort = Number(local);
  const remotePort = Number(remote);
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
    throw new Error('localPort must be between 0 and 65535.');
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error('remotePort must be between 1 and 65535.');
  }
  return { localPort, remotePort };
}

export default class IosForward extends BaseCommand {
  static summary = 'Access a server inside the simulator through localhost';
  static description =
    'Forward a local TCP port to a server running inside the remote iOS Simulator. ' +
    'Use it for HTTP servers, WebDriverAgent, or WebSockets. The listener binds to 127.0.0.1 ' +
    'and stays running until Ctrl+C. Start the server in the simulator separately. ' +
    "The server must accept connections on the simulator's assigned IP, for example by binding to 0.0.0.0. " +
    'Older CLI or simulator versions require the client to send data first. UDP is not supported.';
  static examples = [
    '<%= config.bin %> ios forward 8100 --id <instance-ID>',
    '<%= config.bin %> ios forward 8080:3000 --id <instance-ID>',
    '<%= config.bin %> ios forward 0:8100 --id <instance-ID> --json',
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
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosForward);
    this.setParsedFlags(flags);
    const { localPort, remotePort } = parseMapping(args.mapping);

    await this.withAuth(
      async () => {
        const target = this.resolveIosInstance(flags.id);
        const { apiUrl, token } = await resolveIosConnection(this.client, target);
        const url = new URL(apiUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error(`Unsupported apiUrl protocol: ${url.protocol}`);
        }
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = `${url.pathname.replace(/\/$/, '')}/port-forward`;
        url.search = '';
        url.hash = '';
        url.searchParams.set('port', String(remotePort));

        const tunnel = await startTcpTunnel(url.toString(), token, '127.0.0.1', localPort, {
          mode: 'multiplexed',
          logLevel: 'none',
        });
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
              reject(new Error('Port forward disconnected. Run lim ios forward again to reconnect.'));
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
              instanceId: target.id,
              localHost: tunnel.address.address,
              localPort: tunnel.address.port,
              remotePort,
            };
            try {
              if (flags.json) {
                this.outputJson(ready);
              } else {
                this.output(`${ready.localHost}:${ready.localPort} -> ${target.id}:${remotePort}`);
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
      },
      // A replacement instance would not contain the server the user is forwarding.
      { createReplacement: false },
    );
  }
}
