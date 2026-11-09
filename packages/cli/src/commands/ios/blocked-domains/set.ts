import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosBlockedDomainsSet extends BaseCommand {
  static summary = 'Replace the domains a running iOS instance cannot resolve';
  static description =
    'Each domain is an exact name, or a *. wildcard that covers every subdomain but not the name itself, ' +
    'so blocking a whole site takes both example.com and "*.example.com". Quote wildcards so the shell ' +
    'does not expand them. The list replaces the current one, and passing no domains unblocks everything. ' +
    'Safari and apps that already hold a connection keep it until they reconnect.';

  static examples = [
    "<%= config.bin %> ios blocked-domains set facebook.com '*.facebook.com'",
    '<%= config.bin %> ios blocked-domains set instagram.com --id <instance-ID>',
    '<%= config.bin %> ios blocked-domains set',
  ];

  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(IosBlockedDomainsSet);
    this.setParsedFlags(flags);
    const domains = argv as string[];

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const blocked = await client.setBlockedDomains(domains);
        if (flags.json) {
          this.outputJson({ ok: true, instanceId: resolvedInstance.id, domains: blocked });
        } else if (blocked.length === 0) {
          this.output('No domains are blocked');
        } else {
          this.output(`Blocked ${blocked.join(', ')}`);
        }
      } finally {
        disconnect();
      }
    });
  }
}
