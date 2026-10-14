import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { iosProxyToolError, parseProxyAddress } from '../../../lib/device-proxy';
import { runIosSimctl } from '../../../lib/instance-client-factory';

export default class IosProxySet extends BaseCommand {
  static summary = 'Set the system proxy of a running iOS instance';
  static description =
    "Point the simulator's system HTTP and HTTPS proxy at host:port. Safari, apps and the simulator's own " +
    'services send new connections through it, while localhost stays direct. To reach a proxy on your ' +
    'machine or private network, expose it with a tunnel run with --no-inspect, because inspection ' +
    'breaks proxied traffic. Clear the proxy before you stop that tunnel, or the device loses its ' +
    'network. Same as ' +
    '`lim ios simctl -- spawn booted limproxy set <host> <port>`.';
  static examples = [
    '<%= config.bin %> ios tunnel --selector localhost:3128 --no-inspect --detach\n<%= config.bin %> ios proxy set localhost:3128',
    '<%= config.bin %> ios proxy set proxy.acme.internal:3128 --id <instance-ID>',
  ];

  static args = {
    proxy: Args.string({
      description: 'Proxy as host:port. The host is a name or an IPv4 address.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosProxySet);
    this.setParsedFlags(flags);

    let proxy;
    try {
      proxy = parseProxyAddress(args.proxy);
    } catch (error) {
      this.error((error as Error).message);
    }
    const address = `${proxy.host}:${proxy.port}`;

    // A replacement instance would have none of the tunnels the proxy relies on.
    await this.withAuth(
      async () => {
        const result = await runIosSimctl(this.client, this.resolveIosInstance(flags.id), [
          'spawn',
          'booted',
          'limproxy',
          'set',
          proxy.host,
          String(proxy.port),
        ]);
        if (result.code !== 0) {
          this.error(iosProxyToolError(result), { exit: result.code });
        }
        if (flags.json) {
          this.outputJson({ proxy: address });
        } else {
          this.output(
            `System proxy set to ${address}. New connections use it; relaunch apps to close connections opened before.`,
          );
        }
      },
      { createReplacement: false },
    );
  }
}
