import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosBlocklistList extends BaseCommand {
  static summary = 'List the domains blocked on a running iOS instance';

  static examples = [
    '<%= config.bin %> ios blocklist list',
    '<%= config.bin %> ios blocklist list --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosBlocklistList);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
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
