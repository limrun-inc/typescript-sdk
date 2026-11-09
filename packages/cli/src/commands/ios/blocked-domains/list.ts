import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosBlockedDomainsList extends BaseCommand {
  static summary = 'List the domains a running iOS instance cannot resolve';

  static examples = [
    '<%= config.bin %> ios blocked-domains list',
    '<%= config.bin %> ios blocked-domains list --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosBlockedDomainsList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
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
