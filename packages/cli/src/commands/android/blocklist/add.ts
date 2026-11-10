import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { addToBlocklist } from '../../../lib/blocklist';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

export default class AndroidBlocklistAdd extends BaseCommand {
  static summary = 'Block domains on a running Android instance';
  static description =
    'A blocked domain does not resolve on the device. Each entry is an exact name, or a *. wildcard that ' +
    'covers every subdomain but not the name itself, so blocking a whole site takes both example.com and ' +
    '"*.example.com". Quote wildcards so the shell does not expand them. Chrome and apps that already hold a ' +
    'connection keep it until they reconnect.';

  static examples = [
    "<%= config.bin %> android blocklist add facebook.com '*.facebook.com'",
    '<%= config.bin %> android blocklist add instagram.com --id <instance-ID>',
  ];

  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(AndroidBlocklistAdd);
    this.setParsedFlags(flags);
    const names = argv as string[];
    if (names.length === 0) {
      this.error('Name at least one domain to block.');
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
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
