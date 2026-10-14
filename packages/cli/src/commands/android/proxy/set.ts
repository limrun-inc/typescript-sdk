import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { parseProxyAddress } from '../../../lib/device-proxy';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

export default class AndroidProxySet extends BaseCommand {
  static summary = 'Set the system proxy of a running Android instance';
  static description =
    "Point the device's global HTTP proxy at host:port. Chrome, WebViews and apps that use the system " +
    'proxy send new connections through it. To reach a proxy on your machine or private network, expose ' +
    'it with a tunnel run with --no-inspect, because inspection breaks proxied traffic. Clear the proxy ' +
    'before you stop that tunnel, or the device loses its network. Same as ' +
    '`lim android adb-shell -- settings put global http_proxy <host:port>`.';
  static examples = [
    '<%= config.bin %> android tunnel --selector localhost:3128 --no-inspect\n<%= config.bin %> android proxy set localhost:3128',
    '<%= config.bin %> android proxy set proxy.acme.internal:3128 --id <instance-ID>',
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
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidProxySet);
    this.setParsedFlags(flags);

    let proxy;
    try {
      proxy = parseProxyAddress(args.proxy);
    } catch (error) {
      this.error((error as Error).message);
    }
    const address = `${proxy.host}:${proxy.port}`;

    await this.withAuth(async () => {
      const { client, disconnect } = await getAndroidInstanceClient(
        this.client,
        this.resolveAndroidInstance(flags.id),
      );
      try {
        const result = await client.adbShell('settings', ['put', 'global', 'http_proxy', address]);
        if (result.exitCode !== 0) {
          this.error(result.stderr.trim() || `settings failed with exit code ${result.exitCode}`, {
            exit: result.exitCode,
          });
        }
      } finally {
        disconnect();
      }
      if (flags.json) {
        this.outputJson({ proxy: address });
      } else {
        this.output(`System proxy set to ${address}. Relaunch apps that connected before.`);
      }
    });
  }
}
