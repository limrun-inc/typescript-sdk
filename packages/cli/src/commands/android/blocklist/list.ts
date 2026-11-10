import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

export default class AndroidBlocklistList extends BaseCommand {
  static summary = 'List the domains blocked on a running Android instance';

  static examples = [
    '<%= config.bin %> android blocklist list',
    '<%= config.bin %> android blocklist list --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidBlocklistList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        const blocked = await client.getBlockedDomains();
        if (flags.json) {
          this.outputJson({ instanceId: resolvedInstance.id, domains: blocked });
        } else if (blocked.length === 0) {
          this.output('The blocklist is empty');
        } else {
          this.output(blocked.join('\n'));
        }
      } finally {
        disconnect();
      }
    });
  }
}
