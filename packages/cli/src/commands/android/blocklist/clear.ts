import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

export default class AndroidBlocklistClear extends BaseCommand {
  static summary = 'Unblock every domain on a running Android instance';

  static examples = [
    '<%= config.bin %> android blocklist clear',
    '<%= config.bin %> android blocklist clear --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidBlocklistClear);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        await client.setBlockedDomains([]);
        if (flags.json) {
          this.outputJson({ ok: true, instanceId: resolvedInstance.id, domains: [] });
        } else {
          this.output('The blocklist is empty');
        }
      } finally {
        disconnect();
      }
    });
  }
}
