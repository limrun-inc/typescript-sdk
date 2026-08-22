import { Args, Flags } from '@oclif/core';
import type { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';
import { parseReversePortMapping } from '../../lib/reverse-port-mapping';

// devUrl returns the URL the simulator should open for this tunnel: the
// Expo dev-client deep link when a scheme is given, the plain tunnel URL
// otherwise.
function devUrl(host: string, port: number, scheme: string | undefined): string {
  const url = `http://${host}:${port}`;
  return scheme ? `${scheme}://expo-development-client/?url=${encodeURIComponent(url)}` : url;
}

export default class IosReverse extends BaseCommand {
  static summary = 'Expose a local client-first service to the simulator';
  static description =
    'Open a long-lived reverse tunnel so an app in the remote iOS Simulator can connect to LISTEN_IP:remotePort and reach a local client-first service such as an HTTP or WebSocket dev server. Remote ports must be in the reserved Limrun range 57090-57099.';
  static examples = [
    '<%= config.bin %> ios reverse 57090:8081 --id <instance-ID>',
    '<%= config.bin %> ios reverse 57091:3000 --id <instance-ID>',
    '<%= config.bin %> ios reverse 57090:8081 --local-host 127.0.0.1',
    '<%= config.bin %> ios open-url "$(<%= config.bin %> ios reverse 57090:57090 --detach --scheme myapp)"',
  ];

  static args = {
    mapping: Args.string({
      description:
        'Port mapping as <remotePort> or <remotePort>:<localPort>. remotePort must be 57090-57099.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'iOS instance ID to target. Defaults to the last created iOS instance, but `--id` is recommended for scripts and agents.',
    }),
    'local-host': Flags.string({
      description:
        'Host for the local service on your machine. Defaults to 127.0.0.1; non-loopback hosts are intended for debugging.',
      default: '127.0.0.1',
    }),
    detach: Flags.boolean({
      description:
        'Start the tunnel in the background session daemon and print only the tunnel URL (http://<host>:<remotePort>) to stdout, so it composes with other commands: `lim ios open-url "$(lim ios reverse 57090:57090 --detach --scheme myapp)"`. The tunnel lives until the daemon is shut down with `lim session stop` or the instance ends.',
      default: false,
    }),
    scheme: Flags.string({
      description:
        'URL scheme of the Expo dev client installed on the simulator. When set, the printed URL is the dev-client deep link (myapp://expo-development-client/?url=<encoded tunnel URL>) instead of the plain tunnel URL. The scheme is in the app config: app.json "scheme" field, or exp+<lowercased slug> if it has none.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosReverse);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const { remotePort, localPort } = parseReversePortMapping(args.mapping);
      const localHost = flags['local-host'];
      const resolvedInstance = this.resolveIosInstance(flags.id);

      if (flags.detach) {
        if (!(await ensureDaemonSession(resolvedInstance))) {
          this.error(
            'Could not start the background session daemon that --detach needs. ' +
              'Run without --detach to keep the tunnel in the foreground.',
          );
        }
        const result = (await sendSessionCommand(resolvedInstance.id, 'reverse', [
          remotePort,
          localPort,
          localHost,
        ])) as { remoteHost: string; remotePort: number };
        const url = devUrl(result.remoteHost, result.remotePort, flags.scheme);
        if (flags.json) {
          this.outputJson({
            instanceId: resolvedInstance.id,
            remoteHost: result.remoteHost,
            remotePort: result.remotePort,
            localHost,
            localPort,
            url,
          });
        } else {
          // Only the URL goes to stdout so `$(lim ios reverse ... --detach)`
          // captures a clean value.
          this.output(url);
        }
        return;
      }

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      let tunnel: Ios.ReverseTunnel | undefined;

      try {
        tunnel = await client.startReverseTunnel({
          remotePort,
          localPort,
          localHost,
          logLevel: flags.json || flags.quiet ? 'none' : 'info',
        });

        const ready = {
          instanceId: resolvedInstance.id,
          remoteHost: tunnel.remoteAddress.address,
          remotePort: tunnel.remoteAddress.port,
          localHost,
          localPort,
        };

        if (flags.json) {
          this.outputJson({ ...ready, url: devUrl(ready.remoteHost, ready.remotePort, flags.scheme) });
        } else {
          this.output(`Remote endpoint: ${ready.remoteHost}:${ready.remotePort}`);
          this.output(`${ready.remoteHost}:${ready.remotePort} -> ${ready.localHost}:${ready.localPort}`);
          this.output(
            `Use ${ready.remoteHost}:${ready.remotePort} from the simulator (for example exp://${ready.remoteHost}:${ready.remotePort}).`,
          );
          if (flags.scheme) {
            this.output(
              `Open the dev client with: lim ios open-url "${devUrl(
                ready.remoteHost,
                ready.remotePort,
                flags.scheme,
              )}"`,
            );
          }
          this.info('Reverse tunnel started. Press Ctrl+C to stop.');
        }

        const activeTunnel: Ios.ReverseTunnel = tunnel;
        await new Promise<void>((resolve, reject) => {
          const keepAlive = setInterval(() => {}, 1 << 30);
          let stopping = false;
          const cleanup = () => {
            clearInterval(keepAlive);
            unsubscribe();
            process.off('SIGINT', shutdown);
            process.off('SIGTERM', shutdown);
          };
          const shutdown = () => {
            stopping = true;
            cleanup();
            this.info('Stopping reverse tunnel...');
            resolve();
          };
          const unsubscribe = activeTunnel.onConnectionStateChange((state) => {
            if (state === 'disconnected' && !stopping) {
              cleanup();
              reject(new Error('Reverse tunnel disconnected unexpectedly'));
            }
          });
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
        });
      } finally {
        tunnel?.close();
        disconnect();
      }
    });
  }
}
