import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosBlocklistClear extends BaseCommand {
  static summary = 'Unblock every domain on a running iOS instance';

  static examples = [
    '<%= config.bin %> ios blocklist clear',
    '<%= config.bin %> ios blocklist clear --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosBlocklistClear);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
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
