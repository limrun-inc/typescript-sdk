import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { removeFromBlocklist } from '../../../lib/blocklist';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosBlocklistRemove extends BaseCommand {
  static summary = 'Unblock domains on a running iOS instance';
  static description =
    'Remove entries from the blocklist exactly as they were added: removing example.com leaves ' +
    '"*.example.com" in place. A name the blocklist does not hold is ignored.';

  static examples = [
    "<%= config.bin %> ios blocklist remove facebook.com '*.facebook.com'",
    '<%= config.bin %> ios blocklist remove instagram.com --id <instance-ID>',
  ];

  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(IosBlocklistRemove);
    this.setParsedFlags(flags);
    const names = argv as string[];
    if (names.length === 0) {
      this.error('Name at least one domain to unblock, or run `blocklist clear` to unblock everything.');
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const blocked = await client.setBlockedDomains(
          removeFromBlocklist(await client.getBlockedDomains(), names),
        );
        if (flags.json) {
          this.outputJson({ ok: true, instanceId: resolvedInstance.id, domains: blocked });
        } else if (blocked.length === 0) {
          this.output('The blocklist is empty');
        } else {
          this.output(`Blocklist: ${blocked.join(', ')}`);
        }
      } finally {
        disconnect();
      }
    });
  }
}
