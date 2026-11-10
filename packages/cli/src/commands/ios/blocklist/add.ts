import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { addToBlocklist } from '../../../lib/blocklist';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosBlocklistAdd extends BaseCommand {
  static summary = 'Block domains on a running iOS instance';
  static description =
    'A blocked domain does not resolve on the device. Each entry is an exact name, or a *. wildcard that ' +
    'covers every subdomain but not the name itself, so blocking a whole site takes both example.com and ' +
    '"*.example.com". Quote wildcards so the shell does not expand them. Safari and apps that already hold a ' +
    'connection keep it until they reconnect.';

  static examples = [
    "<%= config.bin %> ios blocklist add facebook.com '*.facebook.com'",
    '<%= config.bin %> ios blocklist add instagram.com --id <instance-ID>',
  ];

  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(IosBlocklistAdd);
    this.setParsedFlags(flags);
    const names = argv as string[];
    if (names.length === 0) {
      this.error('Name at least one domain to block.');
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const blocked = await client.setBlockedDomains(
          addToBlocklist(await client.getBlockedDomains(), names),
        );
        if (flags.json) {
          this.outputJson({ ok: true, instanceId: resolvedInstance.id, domains: blocked });
        } else {
          this.output(`Blocklist: ${blocked.join(', ')}`);
        }
      } finally {
        disconnect();
      }
    });
  }
}
