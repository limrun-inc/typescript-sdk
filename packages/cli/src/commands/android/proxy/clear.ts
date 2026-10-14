import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

export default class AndroidProxyClear extends BaseCommand {
  static summary = 'Clear the system proxy of a running Android instance';
  static description =
    "Clear the device's global HTTP proxy, so new connections go direct again. Same as " +
    '`lim android adb-shell -- settings put global http_proxy :0`.';
  static examples = [
    '<%= config.bin %> android proxy clear',
    '<%= config.bin %> android proxy clear --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidProxyClear);
    this.setParsedFlags(flags);

    // A replacement instance would have none of the tunnels the proxy relies on.
    await this.withAuth(
      async () => {
        const { client, disconnect } = await getAndroidInstanceClient(
          this.client,
          this.resolveAndroidInstance(flags.id),
        );
        try {
          // An empty host with port 0 means no proxy.
          const result = await client.adbShell('settings', ['put', 'global', 'http_proxy', ':0']);
          if (result.exitCode !== 0) {
            this.error(result.stderr.trim() || `settings failed with exit code ${result.exitCode}`, {
              exit: result.exitCode,
            });
          }
        } finally {
          disconnect();
        }
        if (flags.json) {
          this.outputJson({ proxy: null });
        } else {
          this.output(
            'System proxy cleared. New connections go direct; relaunch apps to close connections opened through the proxy.',
          );
        }
      },
      { createReplacement: false },
    );
  }
}
