import { Args, Flags } from '@oclif/core';
import { startTcpTunnel } from '@limrun/api/tunnel';
import { BaseCommand } from '../../base-command';
import { inheritedFlags, startDetached } from '../../lib/detached';
import { resolveIosConnection } from '../../lib/instance-client-factory';
import { parsePortMapping } from '../../lib/port-mapping';

export default class IosForward extends BaseCommand {
  static summary = 'Access a server inside the simulator through localhost';
  static description =
    'Forward a local TCP port to a server running inside the remote iOS Simulator. ' +
    'Use it for HTTP servers, WebDriverAgent, or WebSockets. The listener binds to 127.0.0.1 ' +
    'and runs in a background process that the command prints the PID of; stop it with kill <pid>, ' +
    'or pass --no-detach to keep it in the foreground until Ctrl+C. Start the server in the simulator separately. ' +
    "The server must accept connections on the simulator's assigned IP, for example by binding to 0.0.0.0. " +
    'Protocols where the server sends data first and UDP are not supported.';
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
    detach: Flags.boolean({
      description:
        'Run the forward in a background process and return once it listens. Use --no-detach to stay in the foreground until Ctrl+C.',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosForward);
    this.setParsedFlags(flags);
    const { localPort, remotePort } = parsePortMapping(args.mapping);

    if (flags.detach) {
      const id = this.resolveIosInstance(flags.id).id;
      const { pid, logPath, ready } = await startDetached({
        name: `ios-forward-${id}-${args.mapping.replace(':', '-')}`,
        args: ['ios', 'forward', args.mapping, '--id', id, ...inheritedFlags(flags)],
      });
      if (flags.json) {
        this.outputJson({ ...ready, pid, logPath });
      } else {
        this.output(`${String(ready['localHost'])}:${String(ready['localPort'])} -> ${id}:${remotePort}`);
        this.info(`Port forward running in the background. Stop it with kill ${pid}.`);
      }
      return;
    }

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
