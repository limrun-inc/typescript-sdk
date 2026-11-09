import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

export default class AndroidBlockedDomainsList extends BaseCommand {
  static summary = 'List the domains a running Android instance cannot resolve';

  static examples = [
    '<%= config.bin %> android blocked-domains list',
    '<%= config.bin %> android blocked-domains list --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidBlockedDomainsList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        const blocked = await client.getBlockedDomains();
        if (flags.json) {
          this.outputJson({ instanceId: resolvedInstance.id, domains: blocked });
        } else if (blocked.length === 0) {
          this.output('No domains are blocked');
        } else {
          this.output(blocked.join('\n'));
        }
      } finally {
        disconnect();
      }
    });
  }
}
