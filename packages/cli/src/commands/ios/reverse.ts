import { Args, Flags } from '@oclif/core';
import type { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';
import { parseReversePortMapping } from '../../lib/reverse-port-mapping';

export default class IosReverse extends BaseCommand {
  static summary = 'Expose a local client-first service to the simulator';
  static description =
    'Open a long-lived reverse tunnel so an app in the remote iOS Simulator can connect to LISTEN_IP:remotePort and reach a local client-first service such as an HTTP or WebSocket dev server. Remote ports must be in the reserved Limrun range 57090-57099.';
  static examples = [
    '<%= config.bin %> ios reverse 57090:8081 --id <instance-ID>',
    '<%= config.bin %> ios reverse 57091:3000 --id <instance-ID>',
    '<%= config.bin %> ios reverse 57090:8081 --local-host 127.0.0.1',
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosReverse);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const { remotePort, localPort } = parseReversePortMapping(args.mapping);
      const localHost = flags['local-host'];
      const resolvedInstance = this.resolveIosInstance(flags.id);
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
          this.outputJson(ready);
        } else {
          this.output(`Remote endpoint: ${ready.remoteHost}:${ready.remotePort}`);
          this.output(`${ready.remoteHost}:${ready.remotePort} -> ${ready.localHost}:${ready.localPort}`);
          this.output(
            `Use ${ready.remoteHost}:${ready.remotePort} from the simulator (for example exp://${ready.remoteHost}:${ready.remotePort}).`,
          );
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
