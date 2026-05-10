import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

type LsofEntry = {
  kind: 'unix';
  path: string;
};

export default class IosLsof extends BaseCommand {
  static summary = 'List open files on a running iOS instance';
  static description =
    'List open files exposed by the simulator environment. This is especially useful for discovering UNIX sockets before starting a tunnel or other lower-level debugging.';
  static examples = [
    '<%= config.bin %> ios lsof',
    '<%= config.bin %> ios lsof --id <instance-ID>',
    '<%= config.bin %> ios lsof --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to inspect. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosLsof);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('ios lsof only supports iOS instances');
      }

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const entries = (await client.lsof()) as LsofEntry[];
        if (flags.json) {
          this.outputJson(entries);
        } else {
          this.outputTable(
            ['Kind', 'Path'],
            entries.map((entry) => [entry.kind, entry.path]),
          );
        }
      } finally {
        disconnect();
      }
    });
  }
}
